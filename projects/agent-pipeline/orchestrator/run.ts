// orchestrator/run.ts
//
// Phase 4: the first nine stages run for real against the Claude Agent SDK.
//   product-understanding -> product-alignment -> deep-discovery ->
//   design-planning -> architecture-planning -> implementation-planning ->
//   system-design -> low-level-design -> spec-implementer
// Everything past spec-implementer is still stubbed (see STAGE_IO below), as
// are feedback-router and critic. testing-agent in particular cannot ship
// before the sandbox (module M18) exists: it needs Playwright, i.e. a shell.
//
// spec-implementer is the first stage that is not a document stage, and it
// broke four assumptions this file used to make. Each is now generalised rather
// than special-cased on the stage name:
//   1. a stage wrote ONE document      -> StageIo.writes is a StageOutput union
//   2. hasRealContent() was the verifier -> per-output-kind verification
//   3. cwd was always PROJECT_ROOT     -> StageIo.cwd is "project" | "workspace"
//   4. the budget cap was per-query()  -> RunBudget caps the whole run

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  AgentDefinition,
  Options,
  PermissionMode,
  SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";
import {
  loadState,
  saveState,
  beginStage,
  finishStage,
  recordRetry,
  MAX_RETRIES_PER_STAGE,
} from "./state.js";
import { PROJECT_ROOT, loadAgentDefinition } from "./agent-loader.js";
import { PIPELINE_STAGES } from "./types.js";
import type { PipelineStage, FeedbackRouterDecision, RunState, StageOutcome } from "./types.js";
import { MAX_BUDGET_USD_PER_RUN, RunBudget } from "./budget.js";
import { loadModules } from "./modules.js";
import type { ModuleSpec } from "./modules.js";
import {
  changedFiles,
  ensureWorkspace,
  snapshotWorkspace,
  typecheckWorkspace,
  workspaceRoot,
} from "./workspace.js";
import { appendProgress, completedModuleIds, loadProgress } from "./progress.js";
import type { ProgressLog } from "./progress.js";
import { parseReportedProgress, verifyModule } from "./verify.js";

/**
 * The pipeline is non-interactive: there is no human sitting there to answer a
 * permission prompt, so any prompting mode would simply hang forever. The real
 * blast-radius control is (a) each agent's `tools` allowlist, parsed from its
 * own frontmatter — spec-implementer has no Bash at all — and (b) cwd scoping,
 * to PROJECT_ROOT for document stages and to a workspace OUTSIDE this repo for
 * the code-writing stage.
 */
const PERMISSION_MODE: PermissionMode = "bypassPermissions";

/**
 * Per-query() spend cap, passed to the SDK as `maxBudgetUsd`. The SDK returns
 * an `error_max_budget_usd` result instead of running away, which we treat as
 * an ordinary failure.
 *
 * Raised from $2.00 for Phase 3: the live Phase 2 run cost ~$0.76 per stage for
 * documents of ~6-11k output tokens, and low-level-design has to produce
 * implementation-ready specs for every module. It doubles as the per-MODULE cap
 * in Phase 4 — one module's code is the same order of output as one document.
 */
const MAX_BUDGET_USD_PER_STAGE = 4.0;

/**
 * Minimum headroom required to start another query(). An allowance of a few
 * cents buys a call that is guaranteed to die of `error_max_budget_usd`
 * partway through: money spent, nothing produced. Below this, halt cleanly.
 */
const MIN_BUDGET_HEADROOM_USD = 0.5;

/**
 * How many modules one invocation may build. Deliberately tiny: the first live
 * run of a loop that writes real code should be cheap enough to throw away, and
 * raising it is a decision the human makes with `--max-modules N`. Modules
 * already recorded complete in the workspace progress log are skipped, so a
 * second run continues rather than redoing.
 */
const DEFAULT_MAX_MODULES = 2;

/** The phase this build implements, used only for console/error wording. */
const CURRENT_PHASE = 4;

/** Phase 4 stops here; the later stages have no STAGE_IO entry yet. */
const LAST_IMPLEMENTED_STAGE: PipelineStage = "spec-implementer";

/** Where the raw product idea is persisted so re-runs and agents can see it. */
const IDEA_DOC = "docs/idea.md";

/** The module breakdown spec-implementer loops over. */
const IMPLEMENTER_DOC = "docs/implementer.md";

/** Absolute path to the pipeline's docs, granted to the workspace stage read-only. */
const DOCS_DIR = path.join(PROJECT_ROOT, "docs");

/**
 * What a stage produces.
 *
 * Through Phase 3 this was a single string, because every stage wrote exactly
 * one markdown file. spec-implementer writes many files to paths nobody can
 * name in advance, so the field became a discriminated union: the control loop
 * branches on the KIND of output, never on the stage's name.
 */
type StageOutput =
  | { kind: "document"; path: string }
  | { kind: "workspace-modules"; moduleDoc: string };

/** Which root a stage runs in. Document stages read and write docs/ in place. */
type StageCwd = "project" | "workspace";

/** Which docs a stage reads, what it produces, and where it runs. */
interface StageIo {
  reads: string[];
  writes: StageOutput;
  cwd: StageCwd;
}

/**
 * Stage doc I/O as data rather than a pile of if-statements. Only the stages
 * implemented so far have entries; the rest throw "not implemented".
 */
const STAGE_IO: Partial<Record<PipelineStage, StageIo>> = {
  "product-understanding": {
    reads: [IDEA_DOC],
    writes: { kind: "document", path: "docs/product_understanding.md" },
    cwd: "project",
  },
  "product-alignment": {
    reads: [IDEA_DOC, "docs/product_understanding.md"],
    writes: { kind: "document", path: "docs/classification.md" },
    cwd: "project",
  },
  "deep-discovery": {
    reads: [IDEA_DOC, "docs/product_understanding.md", "docs/classification.md"],
    writes: { kind: "document", path: "docs/okf.md" },
    cwd: "project",
  },
  "design-planning": {
    reads: [IDEA_DOC, "docs/product_understanding.md", "docs/classification.md", "docs/okf.md"],
    writes: { kind: "document", path: "docs/design.md" },
    cwd: "project",
  },
  "architecture-planning": {
    reads: ["docs/okf.md", "docs/design.md"],
    writes: { kind: "document", path: "docs/architecture.md" },
    cwd: "project",
  },
  "implementation-planning": {
    reads: ["docs/design.md", "docs/architecture.md"],
    writes: { kind: "document", path: IMPLEMENTER_DOC },
    cwd: "project",
  },
  "system-design": {
    reads: ["docs/design.md", "docs/architecture.md", IMPLEMENTER_DOC],
    writes: { kind: "document", path: "docs/hld.md" },
    cwd: "project",
  },
  "low-level-design": {
    reads: [IMPLEMENTER_DOC, "docs/hld.md"],
    writes: { kind: "document", path: "docs/lld.md" },
    cwd: "project",
  },
  "spec-implementer": {
    reads: [IMPLEMENTER_DOC, "docs/lld.md"],
    writes: { kind: "workspace-modules", moduleDoc: IMPLEMENTER_DOC },
    cwd: "workspace",
  },
};

/** One line describing a stage's output, for the "already complete" report. */
function describeOutput(output: StageOutput): string {
  return output.kind === "document"
    ? output.path
    : `${workspaceRoot()}/ (code, one directory tree per the modules in ${output.moduleDoc})`;
}

/**
 * Which phase a stage belongs to, for error/console text. Anything at or
 * before LAST_IMPLEMENTED_STAGE ships in CURRENT_PHASE; everything after it is
 * the next phase at the earliest — hence "Phase N+" wording at the call sites.
 * (This used to be hardcoded 1-or-2, which silently went wrong the moment
 * LAST_IMPLEMENTED_STAGE moved past Phase 1's last stage.)
 */
function phaseForStage(stage: PipelineStage): number {
  return PIPELINE_STAGES.indexOf(stage) <= PIPELINE_STAGES.indexOf(LAST_IMPLEMENTED_STAGE)
    ? CURRENT_PHASE
    : CURRENT_PHASE + 1;
}

function stageIo(stage: PipelineStage): StageIo {
  const io = STAGE_IO[stage];
  if (io === undefined) {
    throw new Error(
      `Stage "${stage}" has no doc I/O mapping — not implemented until Phase ${phaseForStage(stage)}+.`
    );
  }
  return io;
}

/** Resolves StageIo.cwd to an absolute directory. */
function resolveCwd(io: StageIo): string {
  return io.cwd === "workspace" ? workspaceRoot() : PROJECT_ROOT;
}

export interface StageResult {
  /** True only for a fully-completed stage; kept as the field the loop branches on. */
  ok: boolean;
  /**
   * Finer-grained than `ok`. "partial" means real work landed and was recorded
   * but the stage is not finished (module cap reached, or budget exhausted) —
   * it neither advances the pipeline nor burns a retry.
   */
  outcome: StageOutcome;
  text: string;
  costUsd: number;
  numTurns: number;
  /** True when the cumulative run budget stopped the work; the whole run halts. */
  budgetHalt: boolean;
}

/**
 * The docs/*.md placeholders contain only an HTML comment header, so "file
 * exists and has bytes" is not enough to prove a stage did its job. Strip
 * comment headers and whitespace before judging emptiness.
 *
 * This is the verifier for `kind: "document"` outputs ONLY. Workspace outputs
 * are verified by orchestrator/verify.ts, which runs a real typecheck — see
 * runModuleStage.
 */
function hasRealContent(fileText: string): boolean {
  return fileText.replace(/<!--[\s\S]*?-->/g, "").trim().length > 0;
}

function collectAssistantText(message: SDKMessage, sink: string[]): void {
  if (message.type !== "assistant") return;
  for (const block of message.message.content) {
    if (block.type === "text") sink.push(block.text);
  }
}

function buildDocumentPrompt(stage: PipelineStage, io: StageIo, outputPath: string): string {
  const reads =
    io.reads.length > 0
      ? `Read these files first (relative to the current working directory): ${io.reads.join(", ")}.`
      : "You have no upstream documents to read; you are the entry point.";

  // Volatile, run-specific instruction goes here in the `prompt` argument; the
  // stable system prompt comes from agents/<stage>.md. That ordering is what
  // keeps the cached prompt prefix stable across stages and re-runs.
  return [
    `You are running as the "${stage}" stage of an automated product-development pipeline.`,
    reads,
    `Write your output to ${outputPath}, replacing any placeholder content but keeping the existing HTML comment header line at the top of the file.`,
    `The file must end up with substantive markdown content — an empty or header-only file counts as a failed stage.`,
    `Work autonomously: there is no human to ask, so record open questions and assumptions in your output rather than stopping to ask them.`,
    `When you are done, reply with a one-paragraph summary of what you wrote.`,
  ].join("\n\n");
}

/**
 * The per-module instruction for spec-implementer.
 *
 * Note what it does NOT do: paste docs/lld.md. That file is well over a
 * thousand lines, and re-sending all of it on every one of N module calls is
 * the single most expensive mistake available here. The agent has Grep and is
 * told to find its own section.
 */
function buildModulePrompt(
  spec: ModuleSpec,
  position: number,
  total: number,
  completed: string[]
): string {
  const done =
    completed.length > 0
      ? `Modules already built in this workspace: ${completed.join(", ")}. Their files exist ` +
        `already — import from them, and do not rewrite them.`
      : `This is the first module built in this workspace; it is otherwise empty apart from ` +
        `package.json, tsconfig.json and the progress log.`;

  return [
    `You are running as the "spec-implementer" stage of an automated product-development pipeline.`,
    `Build exactly ONE module this call: ${spec.id} (${spec.title}). It is module ${position} of ${total} in the build order.`,
    `The pipeline's design documents are at ${DOCS_DIR} and are READ-ONLY — never write there.`,
    `Do NOT read docs/lld.md end to end. Use Grep on ${path.join(DOCS_DIR, "lld.md")} to find the "${spec.id}" section, then read only that section and whatever it explicitly references.`,
    `Your working directory is ${workspaceRoot()}. All code you write goes there, at paths of your own choosing consistent with the design.`,
    done,
    `Here is ${spec.id}'s entry from ${IMPLEMENTER_DOC}, verbatim:\n\n${spec.body}`,
    spec.reqs.length > 0
      ? `The requirement IDs assigned to ${spec.id} are: ${spec.reqs.join(", ")}. Claim these and only these; claiming a REQ ID this module does not own fails the stage.`
      : `${IMPLEMENTER_DOC} assigns no REQ IDs to ${spec.id}, so report "none" for reqs.`,
    `You have no shell. Write real, complete code — the orchestrator runs tsc against the workspace after this call and rejects placeholder output.`,
    `Finish with the PIPELINE-PROGRESS block described in your instructions.`,
  ].join("\n\n");
}

interface QueryOutcome {
  ok: boolean;
  text: string;
  costUsd: number;
  numTurns: number;
}

/**
 * One `query()` call, drained to its result message.
 *
 * The main thread *runs as* the stage's agent (options.agent + options.agents)
 * rather than spawning a subagent via the Task tool — that keeps every state
 * transition in this control loop.
 *
 * Anything the SDK raises while streaming (network blip, auth failure,
 * transport error) is RETURNED as a failed outcome rather than thrown: those
 * are exactly the failures the caller's retry budget exists for, and letting
 * them escape used to kill the whole run. Configuration faults (a missing
 * STAGE_IO entry, a missing agents/<stage>.md) still throw, from their own call
 * sites — retrying those three times just prints the same error three times.
 */
async function runQueryOnce(
  label: string,
  definition: AgentDefinition,
  stageName: PipelineStage,
  prompt: string,
  extra: { cwd: string; maxBudgetUsd: number; additionalDirectories?: string[] }
): Promise<QueryOutcome> {
  const options: Options = {
    agent: stageName,
    agents: { [stageName]: definition },
    cwd: extra.cwd,
    permissionMode: PERMISSION_MODE,
    maxBudgetUsd: extra.maxBudgetUsd,
    // SDK isolation mode. Without this, the machine's ~/.claude/CLAUDE.md and
    // project/local settings get inherited by every pipeline agent and derail
    // it with instructions that have nothing to do with this pipeline.
    // DO NOT REMOVE — the agents must see only their own system prompt.
    settingSources: [],
  };
  if (definition.tools !== undefined) options.allowedTools = definition.tools;
  if (extra.additionalDirectories !== undefined) {
    options.additionalDirectories = extra.additionalDirectories;
  }

  const assistantText: string[] = [];
  let outcome: QueryOutcome = { ok: false, text: "", costUsd: 0, numTurns: 0 };
  let sawResultMessage = false;

  try {
    for await (const message of query({ prompt, options })) {
      collectAssistantText(message, assistantText);
      if (message.type !== "result") continue;

      sawResultMessage = true;
      const ok = message.subtype === "success" && !message.is_error;
      outcome = {
        ok,
        text: message.subtype === "success" ? message.result : assistantText.join("\n"),
        costUsd: message.total_cost_usd,
        numTurns: message.num_turns,
      };
      if (!ok) console.error(`  [${label}] SDK result was not a success: ${message.subtype}`);
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`  [${label}] SDK call threw: ${detail}`);
    return { ...outcome, ok: false, text: detail };
  }

  if (!sawResultMessage) {
    console.error(
      `  [${label}] the SDK stream ended without a result message — treating as a failed attempt.`
    );
  }
  return outcome;
}

/** A stage whose whole job is one markdown file — the Phase 1-3 shape, unchanged. */
async function runDocumentStage(
  stageName: PipelineStage,
  io: StageIo,
  outputRelPath: string,
  definition: AgentDefinition,
  budget: RunBudget
): Promise<StageResult> {
  const outcome = await runQueryOnce(
    stageName,
    definition,
    stageName,
    buildDocumentPrompt(stageName, io, outputRelPath),
    { cwd: resolveCwd(io), maxBudgetUsd: budget.allowanceFor(MAX_BUDGET_USD_PER_STAGE) }
  );
  budget.record(outcome.costUsd);

  const failed: StageResult = { ...outcome, ok: false, outcome: "failure", budgetHalt: false };
  if (!outcome.ok) return failed;

  // A stage that "succeeds" without producing its artifact would silently
  // poison every downstream stage, so verify the output file for real.
  const outputPath = path.join(PROJECT_ROOT, outputRelPath);
  let outputText: string;
  try {
    outputText = await readFile(outputPath, "utf-8");
  } catch {
    console.error(`  [${stageName}] claimed success but ${outputRelPath} does not exist.`);
    return failed;
  }
  if (!hasRealContent(outputText)) {
    console.error(`  [${stageName}] claimed success but ${outputRelPath} is empty/header-only.`);
    return failed;
  }

  return { ...outcome, ok: true, outcome: "success", budgetHalt: false };
}

/**
 * The module loop: one query() per module, verified by this process after each.
 *
 * Success is never the agent's self-report. After every call the orchestrator
 * checks, in this order: (1) the workspace actually changed, (2) the REQ IDs
 * claimed are a subset of the ones docs/implementer.md assigns the module,
 * (3) what was written is not substantially placeholder, (4) `tsc --noEmit`
 * over the whole workspace is clean apart from TS2307 (unresolved imports,
 * which are expected — there is no shell, so nothing was ever installed).
 *
 * The loop stops at the first module failure rather than carrying on: later
 * modules import earlier ones, so continuing past a broken module buys a
 * cascade of failures at full price.
 */
async function runModuleStage(
  stageName: PipelineStage,
  definition: AgentDefinition,
  budget: RunBudget,
  maxModules: number
): Promise<StageResult> {
  const bootstrap = await ensureWorkspace();
  console.log(`  workspace: ${bootstrap.root}`);
  if (bootstrap.created.length > 0) {
    console.log(`  bootstrapped: ${bootstrap.created.join(", ")}`);
  }

  const modules = await loadModules(IMPLEMENTER_DOC);
  let progress: ProgressLog = await loadProgress();
  const completed = completedModuleIds(progress);
  const pending = modules.filter((module) => !completed.has(module.id));

  console.log(
    `  modules: ${modules.length} in ${IMPLEMENTER_DOC}, ${completed.size} already complete, ` +
      `${pending.length} pending (cap ${maxModules} this run)`
  );

  const aggregate: StageResult = {
    ok: false,
    outcome: "partial",
    text: "",
    costUsd: 0,
    numTurns: 0,
    budgetHalt: false,
  };

  if (pending.length === 0) {
    return { ...aggregate, ok: true, outcome: "success", text: "All modules already complete." };
  }

  const notes: string[] = [];
  let built = 0;

  for (const spec of pending) {
    if (built >= maxModules) {
      notes.push(`stopped at the --max-modules cap of ${maxModules}`);
      break;
    }
    if (!budget.canAfford(MIN_BUDGET_HEADROOM_USD)) {
      notes.push(
        `stopped before ${spec.id}: only $${budget.remaining.toFixed(4)} left of the ` +
          `$${budget.cap.toFixed(2)} run budget, below the $${MIN_BUDGET_HEADROOM_USD.toFixed(2)} minimum`
      );
      aggregate.budgetHalt = true;
      break;
    }

    const position = modules.findIndex((m) => m.id === spec.id) + 1;
    console.log(`  --> ${spec.id} ${spec.title} (module ${position} of ${modules.length})`);

    const startedAt = new Date().toISOString();
    const before = await snapshotWorkspace();

    const outcome = await runQueryOnce(
      `${stageName}/${spec.id}`,
      definition,
      stageName,
      buildModulePrompt(spec, position, modules.length, [...completed]),
      {
        cwd: workspaceRoot(),
        maxBudgetUsd: budget.allowanceFor(MAX_BUDGET_USD_PER_STAGE),
        // The design docs live outside the workspace cwd; this is what makes
        // them readable at all. They are still instructed to be read-only.
        additionalDirectories: [DOCS_DIR],
      }
    );
    budget.record(outcome.costUsd);
    aggregate.costUsd += outcome.costUsd;
    aggregate.numTurns += outcome.numTurns;

    const after = await snapshotWorkspace();
    const written = changedFiles(before, after);
    const reported = parseReportedProgress(outcome.text);

    // The typecheck runs whatever the SDK said, because "the model reported an
    // error" and "the code it already wrote is broken" are different facts, and
    // the second one is the one that has to be recorded.
    const typecheck = await typecheckWorkspace();
    const verification = await verifyModule(spec, written, reported, typecheck);

    const sdkFailure = outcome.ok ? null : `the SDK call did not succeed: ${outcome.text.slice(0, 300)}`;
    const failureReason = sdkFailure ?? verification.failureReason;
    const moduleOk = failureReason === null;

    progress = await appendProgress(progress, {
      moduleId: spec.id,
      title: spec.title,
      startedAt,
      finishedAt: new Date().toISOString(),
      outcome: moduleOk ? "success" : "failure",
      filesWritten: written,
      reqsClaimed: verification.reqsClaimed,
      failureReason,
      deviations: reported.deviations,
      warnings: verification.warnings,
      costUsd: outcome.costUsd,
      numTurns: outcome.numTurns,
    });

    for (const warning of verification.warnings) console.log(`      warning: ${warning}`);

    if (!moduleOk) {
      console.error(`      FAILED — ${failureReason}`);
      notes.push(`${spec.id} failed: ${failureReason}`);
      aggregate.text = notes.join("\n");
      return { ...aggregate, ok: false, outcome: "failure" };
    }

    built += 1;
    completed.add(spec.id);
    console.log(
      `      ok — ${written.length} file(s), ${verification.reqsClaimed.length} REQ(s), ` +
        `$${outcome.costUsd.toFixed(4)}`
    );
  }

  const remaining = modules.filter((module) => !completed.has(module.id));
  if (remaining.length === 0) {
    aggregate.text = `All ${modules.length} modules complete.`;
    return { ...aggregate, ok: true, outcome: "success" };
  }

  notes.push(
    `${remaining.length} module(s) still to build: ${remaining
      .slice(0, 8)
      .map((m) => m.id)
      .join(", ")}${remaining.length > 8 ? ", ..." : ""}`
  );
  aggregate.text = notes.join("\n");
  return { ...aggregate, ok: false, outcome: "partial" };
}

/**
 * Runs a single pipeline stage, dispatching on the KIND of output it produces
 * rather than on its name — that is what keeps the six document stages
 * behaving exactly as they did in Phase 3 while spec-implementer does something
 * structurally different.
 *
 * stageIo()/loadAgentDefinition() THROW: a missing STAGE_IO entry or a
 * missing/malformed agents/<stage>.md is a configuration fault, and retrying it
 * three times just prints the same error three times. Halt and tell the human.
 */
async function runStage(
  stageName: PipelineStage,
  budget: RunBudget = new RunBudget(),
  maxModules: number = DEFAULT_MAX_MODULES
): Promise<StageResult> {
  const io = stageIo(stageName);
  const definition = await loadAgentDefinition(stageName);

  if (io.writes.kind === "document") {
    return runDocumentStage(stageName, io, io.writes.path, definition, budget);
  }
  return runModuleStage(stageName, definition, budget, maxModules);
}

/**
 * Should read docs/feedback_log.md, invoke the feedback-router agent via the
 * SDK, and parse its output into a FeedbackRouterDecision[] that the control
 * loop can act on (i.e. re-run decision.target_stage through the control loop).
 *
 * TODO(later phase, once reviewer/testing-agent produce real feedback):
 * implement the SDK call and the output parsing/validation against the
 * FeedbackRouterDecision shape.
 */
function invokeFeedbackRouter(): never {
  throw new Error("invokeFeedbackRouter() is not implemented yet — later phase.");
}

/**
 * Should invoke the critic agent on demand (not on a fixed schedule) with
 * whatever artifact needs a critical/human-perspective lens.
 *
 * TODO(later phase): implement the SDK call. Callers pass the artifact/context
 * to critique; critic reports back directly rather than writing a fixed doc.
 */
function invokeCritic(_targetDescription: string): never {
  throw new Error("invokeCritic() is not implemented yet — later phase.");
}

/**
 * The stages run in this linear order by default. feedback-router (once
 * implemented) can redirect the control loop back to any earlier stage in
 * this list rather than advancing linearly.
 */
function nextLinearStage(current: PipelineStage | null): PipelineStage | null {
  if (current === null) return PIPELINE_STAGES[0] ?? null;
  const currentIndex = PIPELINE_STAGES.indexOf(current);
  const next = PIPELINE_STAGES[currentIndex + 1];
  return next ?? null;
}

// Re-exported so future phases (and tests) can reference them without
// reaching into this file's internals.
export { runStage, invokeFeedbackRouter, invokeCritic, nextLinearStage };
export type { FeedbackRouterDecision, RunState };

const IDEA_DOC_HEADER =
  "<!-- Written by: the human (via `npm run orchestrator -- \"<idea>\"`). Read by: product-understanding and every later stage. -->";

/**
 * Minimal .env reader — no dependency, and deliberately not a general dotenv
 * implementation. README/setup.sh both tell the user to put ANTHROPIC_API_KEY
 * in .env, and until now nothing read that file, so the key silently never
 * reached the SDK. Only `KEY=VALUE` lines are honoured, and an already-set
 * process.env value always wins.
 */
async function loadDotEnv(): Promise<void> {
  let raw: string;
  try {
    raw = await readFile(path.join(PROJECT_ROOT, ".env"), "utf-8");
  } catch {
    return;
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim().replace(/^export\s+/, "");
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (value.length > 0 && process.env[key] === undefined) process.env[key] = value;
  }
}

/**
 * States which credential the run will actually bill. Without this, a user who
 * left .env blank gets charged against whatever Claude CLI login happens to be
 * on the machine and only finds out afterwards.
 */
function reportAuthSource(): void {
  if (typeof process.env.ANTHROPIC_API_KEY === "string" && process.env.ANTHROPIC_API_KEY.length > 0) {
    console.log("Auth: ANTHROPIC_API_KEY is set (from the environment or .env).");
  } else {
    console.log(
      "Auth: no ANTHROPIC_API_KEY set — the SDK will fall back to this machine's " +
        "Claude CLI login, if any, and bill that account."
    );
  }
}

interface CliArgs {
  /** Free text left after flags are removed; null when none was given. */
  idea: string | null;
  maxModules: number;
}

/**
 * Splits `--flags` out of the product idea. Before Phase 4 every argument was
 * idea text, so `process.argv.slice(2).join(" ")` was enough; `--max-modules`
 * would have been silently written into docs/idea.md.
 */
function parseCliArgs(argv: string[]): CliArgs {
  const words: string[] = [];
  let maxModules = DEFAULT_MAX_MODULES;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);
    if (name !== "--max-modules") {
      throw new Error(`Unrecognised option "${name}". The only supported flag is --max-modules N.`);
    }
    if (value === undefined) {
      value = argv[i + 1];
      i += 1;
    }
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`--max-modules needs a positive integer, got "${value ?? ""}".`);
    }
    maxModules = parsed;
  }

  const idea = words.join(" ").trim();
  return { idea: idea.length > 0 ? idea : null, maxModules };
}

/** The idea currently recorded in docs/idea.md, or null if there isn't one. */
async function readIdeaDocBody(): Promise<string | null> {
  try {
    const existing = await readFile(path.join(PROJECT_ROOT, IDEA_DOC), "utf-8");
    const body = existing
      .replace(/<!--[\s\S]*?-->/g, "")
      .replace(/^#\s*Product idea\s*$/m, "")
      .trim();
    return body.length > 0 ? body : null;
  } catch {
    return null;
  }
}

/** Persists the idea so re-runs and downstream stages can read it. */
async function writeIdeaDoc(idea: string): Promise<void> {
  await writeFile(
    path.join(PROJECT_ROOT, IDEA_DOC),
    `${IDEA_DOC_HEADER}\n\n# Product idea\n\n${idea}\n`,
    "utf-8"
  );
}

/**
 * Prints the "nothing left to run" report. Reached when state/run.json says the
 * last successful stage is at or past LAST_IMPLEMENTED_STAGE — previously this
 * fell through to stageIo() and crashed the run with a "not implemented"
 * error, which is what a user hit simply by running the orchestrator twice.
 */
function reportAlreadyComplete(state: RunState, nextStage: PipelineStage | null): void {
  console.log(
    `Phase ${CURRENT_PHASE} is already complete for this run: "${state.stage}" finished successfully.`
  );
  console.log("");
  console.log("Artifacts on disk:");
  for (const io of Object.values(STAGE_IO)) {
    if (io !== undefined) console.log(`  ${describeOutput(io.writes)}`);
  }
  console.log("");
  if (nextStage === null) {
    console.log("There is no further stage in PIPELINE_STAGES.");
  } else {
    console.log(
      `The next stage ("${nextStage}") is not implemented until Phase ${phaseForStage(nextStage)}+.`
    );
  }
  console.log("To start a fresh run, reset the run state:");
  console.log("");
  console.log("  rm state/run.json && ./setup.sh");
  console.log("");
  console.log(
    `That re-runs the pipeline from "${PIPELINE_STAGES[0]}". Note that setup.sh does ` +
      "NOT clear docs/ — blank those files back to their header comment first if you " +
      "want the new run to start from a clean slate. The code workspace is separate " +
      "and is never reset by setup.sh."
  );
}

async function main(): Promise<void> {
  await loadDotEnv();

  const cli = parseCliArgs(process.argv.slice(2));
  const state0 = await loadState();

  // Resume/completion decisions happen BEFORE docs/idea.md is touched: a
  // finished run should not have its recorded idea overwritten by an argument
  // that is not going to be acted on.
  const firstStage = nextLinearStage(state0.stage);
  if (firstStage === null || STAGE_IO[firstStage] === undefined) {
    reportAlreadyComplete(state0, firstStage);
    if (cli.idea !== null) {
      console.log("");
      console.log("(The idea passed on the command line was NOT applied — nothing ran.)");
    }
    return;
  }

  const idea = cli.idea ?? (await readIdeaDocBody());
  if (idea === null) {
    console.error("No product idea supplied.");
    console.error("");
    console.error('  npm run orchestrator -- "an app that does X"');
    console.error(`  ...or put the idea in ${IDEA_DOC} and re-run.`);
    process.exitCode = 1;
    return;
  }

  // Resuming mid-pipeline is supported, but changing the idea mid-pipeline is
  // not: the already-completed stages ran against the old one.
  if (state0.stage !== null) {
    const previousIdea = await readIdeaDocBody();
    if (previousIdea !== null && previousIdea !== idea) {
      console.warn(
        `Warning: ${IDEA_DOC} is being replaced with a different idea, but stages up to ` +
          `"${state0.stage}" already ran against the previous one. Reset state/run.json ` +
          "for a coherent run."
      );
      console.warn("");
    }
  }
  await writeIdeaDoc(idea);

  console.log(`Idea: ${idea}`);
  reportAuthSource();
  console.log(
    `Phase ${CURRENT_PHASE} runs through "${LAST_IMPLEMENTED_STAGE}"; later stages are still stubbed.`
  );
  console.log(`MAX_RETRIES_PER_STAGE = ${MAX_RETRIES_PER_STAGE}`);
  console.log(
    `Run budget: $${MAX_BUDGET_USD_PER_RUN.toFixed(2)} cumulative, ` +
      `$${MAX_BUDGET_USD_PER_STAGE.toFixed(2)} per call; --max-modules ${cli.maxModules}`
  );
  console.log(`Code workspace: ${workspaceRoot()}`);
  if (state0.stage !== null) {
    console.log(`Resuming: last successful stage was "${state0.stage}", starting at "${firstStage}".`);
  }
  console.log("");

  const budget = new RunBudget(MAX_BUDGET_USD_PER_RUN);
  let state = state0;
  let stage: PipelineStage | null = firstStage;

  while (stage !== null) {
    // The cumulative ceiling is checked before anything is started, so a halt
    // costs nothing and leaves no half-open history entry.
    if (!budget.canAfford(MIN_BUDGET_HEADROOM_USD)) {
      console.log("");
      console.log(
        `Run budget exhausted before "${stage}": spent $${budget.spent.toFixed(4)} of ` +
          `$${budget.cap.toFixed(2)}. Nothing was started. Re-run to continue from here.`
      );
      break;
    }

    console.log(`==> ${stage}`);

    // Open the history entry before the agent runs, so a crash or a kill mid
    // stage leaves an honest "in-progress" record rather than no record.
    state = beginStage(state, stage);
    await saveState(state);

    const result = await runStage(stage, budget, cli.maxModules);

    if (result.outcome === "success") {
      state = finishStage(state, stage, "success");
      await saveState(state);
      console.log(
        `    ok — ${result.numTurns} turns, $${result.costUsd.toFixed(4)} ` +
          `(cumulative $${budget.spent.toFixed(4)} of $${budget.cap.toFixed(2)})`
      );

      if (stage === LAST_IMPLEMENTED_STAGE) {
        console.log("");
        console.log(`Stopping at "${LAST_IMPLEMENTED_STAGE}" — end of Phase ${CURRENT_PHASE}.`);
        break;
      }
      stage = nextLinearStage(stage);
      continue;
    }

    if (result.outcome === "partial") {
      // Real work landed and is recorded; the stage simply is not finished.
      // Neither advance the pipeline nor spend a retry on it.
      state = finishStage(state, stage, "partial");
      await saveState(state);
      console.log(
        `    partial — ${result.numTurns} turns, $${result.costUsd.toFixed(4)} ` +
          `(cumulative $${budget.spent.toFixed(4)} of $${budget.cap.toFixed(2)})`
      );
      for (const line of result.text.split("\n").filter((l) => l.trim().length > 0)) {
        console.log(`    ${line}`);
      }
      console.log("");
      console.log(
        result.budgetHalt
          ? `Halted on the cumulative run budget. Raise MAX_BUDGET_USD_PER_RUN or re-run to continue.`
          : `Re-run to continue "${stage}" — completed work is skipped, not redone.`
      );
      break;
    }

    // Failure: close the entry as a failure and persist that BEFORE recordRetry,
    // which throws past MAX_RETRIES_PER_STAGE and would otherwise take the
    // record of the final failed attempt down with it.
    state = finishStage(state, stage, "failure");
    await saveState(state);

    const attemptsUsed = (state.retries[stage] ?? 0) + 1;
    console.log(
      `    failed — ${result.numTurns} turns, $${result.costUsd.toFixed(4)} ` +
        `(cumulative $${budget.spent.toFixed(4)}); retry ${attemptsUsed} of ${MAX_RETRIES_PER_STAGE}`
    );

    try {
      state = recordRetry(state, stage);
    } catch (err) {
      console.log(`Total cost: $${budget.spent.toFixed(4)}`);
      throw err;
    }
    await saveState(state);
  }

  console.log(`Total cost: $${budget.spent.toFixed(4)} of $${budget.cap.toFixed(2)}`);
}

/**
 * Only run the pipeline when this file is the process entry point. Without the
 * guard, the exports above (runStage, nextLinearStage, ...) — which the header
 * comment offers to later phases and tests — cannot be imported without
 * kicking off a real, billable run as a side effect of the import.
 */
const isEntryPoint =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isEntryPoint) {
  main().catch((err: unknown) => {
    // Config faults and the retry-cap halt both arrive here, and their messages
    // are written to be read by a human — a raw stack dump buries them. Set
    // PIPELINE_DEBUG=1 when the stack is what you actually need.
    if (err instanceof Error) {
      console.error("");
      console.error(`Run halted: ${err.message}`);
      if (process.env.PIPELINE_DEBUG === "1" && typeof err.stack === "string") {
        console.error(err.stack);
      }
    } else {
      console.error(err);
    }
    process.exitCode = 1;
  });
}
