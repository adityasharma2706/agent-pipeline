// orchestrator/run.ts
//
// Phase 2: the first six stages run for real against the Claude Agent SDK.
//   product-understanding -> product-alignment -> deep-discovery ->
//   design-planning -> architecture-planning -> implementation-planning
// Everything past implementation-planning is still stubbed (see STAGE_IO
// below), as are feedback-router and critic.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, PermissionMode, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
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
import type { PipelineStage, FeedbackRouterDecision, RunState } from "./types.js";

/**
 * The pipeline is non-interactive: there is no human sitting there to answer a
 * permission prompt, so any prompting mode would simply hang forever. The real
 * blast-radius control is (a) each agent's `tools` allowlist, parsed from its
 * own frontmatter, and (b) cwd scoping to PROJECT_ROOT.
 */
const PERMISSION_MODE: PermissionMode = "bypassPermissions";

/**
 * Per-stage spend cap. An autonomous pipeline that web-searches can burn real
 * money; the SDK returns an `error_max_budget_usd` result instead of running
 * away, which we treat as an ordinary stage failure.
 */
const MAX_BUDGET_USD_PER_STAGE = 2.0;

/** The phase this build implements, used only for console/error wording. */
const CURRENT_PHASE = 2;

/** Phase 2 stops here; the later stages have no STAGE_IO entry yet. */
const LAST_IMPLEMENTED_STAGE: PipelineStage = "implementation-planning";

/** Where the raw product idea is persisted so re-runs and agents can see it. */
const IDEA_DOC = "docs/idea.md";

/** Which docs a stage reads and which single doc it must write. */
interface StageIo {
  reads: string[];
  writes: string;
}

/**
 * Stage doc I/O as data rather than a pile of if-statements. Only the stages
 * implemented so far have entries; the rest throw "not implemented".
 */
const STAGE_IO: Partial<Record<PipelineStage, StageIo>> = {
  "product-understanding": {
    reads: [IDEA_DOC],
    writes: "docs/product_understanding.md",
  },
  "product-alignment": {
    reads: [IDEA_DOC, "docs/product_understanding.md"],
    writes: "docs/classification.md",
  },
  "deep-discovery": {
    reads: [IDEA_DOC, "docs/product_understanding.md", "docs/classification.md"],
    writes: "docs/okf.md",
  },
  "design-planning": {
    reads: [IDEA_DOC, "docs/product_understanding.md", "docs/classification.md", "docs/okf.md"],
    writes: "docs/design.md",
  },
  "architecture-planning": {
    reads: ["docs/okf.md", "docs/design.md"],
    writes: "docs/architecture.md",
  },
  "implementation-planning": {
    reads: ["docs/design.md", "docs/architecture.md"],
    writes: "docs/implementer.md",
  },
};

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

export interface StageResult {
  ok: boolean;
  text: string;
  costUsd: number;
  numTurns: number;
}

/**
 * The docs/*.md placeholders contain only an HTML comment header, so "file
 * exists and has bytes" is not enough to prove a stage did its job. Strip
 * comment headers and whitespace before judging emptiness.
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

function buildTaskPrompt(stage: PipelineStage, io: StageIo): string {
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
    `Write your output to ${io.writes}, replacing any placeholder content but keeping the existing HTML comment header line at the top of the file.`,
    `The file must end up with substantive markdown content — an empty or header-only file counts as a failed stage.`,
    `Work autonomously: there is no human to ask, so record open questions and assumptions in your output rather than stopping to ask them.`,
    `When you are done, reply with a one-paragraph summary of what you wrote.`,
  ].join("\n\n");
}

/**
 * Runs a single pipeline stage as one query() call: the main thread *runs as*
 * the stage's agent (options.agent + options.agents), rather than spawning a
 * subagent via the Task tool — that keeps every state transition in this
 * control loop.
 *
 * Throw vs. return { ok: false } is a deliberate split, because only the
 * latter goes through the caller's retry budget:
 *   - stageIo()/loadAgentDefinition() THROW. A missing STAGE_IO entry or a
 *     missing/malformed agents/<stage>.md is a configuration fault; retrying
 *     it three times just prints the same error three times and burns nothing
 *     useful. Halt and tell the human.
 *   - Anything raised by the SDK while streaming (network blip, auth failure,
 *     transport error) is RETURNED as a failed result. Those are exactly the
 *     failures a retry budget exists for, and letting them escape used to kill
 *     the whole run.
 */
async function runStage(stageName: PipelineStage): Promise<StageResult> {
  const io = stageIo(stageName);
  const definition = await loadAgentDefinition(stageName);

  const options: Options = {
    agent: stageName,
    agents: { [stageName]: definition },
    cwd: PROJECT_ROOT,
    permissionMode: PERMISSION_MODE,
    maxBudgetUsd: MAX_BUDGET_USD_PER_STAGE,
    // SDK isolation mode. Without this, the machine's ~/.claude/CLAUDE.md and
    // project/local settings get inherited by every pipeline agent and derail
    // it with instructions that have nothing to do with this pipeline.
    // DO NOT REMOVE — the agents must see only their own system prompt.
    settingSources: [],
  };
  if (definition.tools !== undefined) options.allowedTools = definition.tools;

  const assistantText: string[] = [];
  let result: StageResult = {
    ok: false,
    text: "",
    costUsd: 0,
    numTurns: 0,
  };

  let sawResultMessage = false;

  try {
    for await (const message of query({ prompt: buildTaskPrompt(stageName, io), options })) {
      collectAssistantText(message, assistantText);
      if (message.type !== "result") continue;

      sawResultMessage = true;
      const ok = message.subtype === "success" && !message.is_error;
      result = {
        ok,
        text: message.subtype === "success" ? message.result : assistantText.join("\n"),
        costUsd: message.total_cost_usd,
        numTurns: message.num_turns,
      };
      if (!ok) {
        console.error(`  [${stageName}] SDK result was not a success: ${message.subtype}`);
      }
    }
  } catch (err) {
    // Keep whatever cost/turn data the stream already reported, but the
    // attempt is a failure the caller may retry.
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`  [${stageName}] SDK call threw: ${detail}`);
    return { ...result, ok: false, text: detail };
  }

  if (!sawResultMessage) {
    console.error(
      `  [${stageName}] the SDK stream ended without a result message — treating as a failed attempt.`
    );
  }

  if (!result.ok) return result;

  // A stage that "succeeds" without producing its artifact would silently
  // poison every downstream stage, so verify the output file for real.
  const outputPath = path.join(PROJECT_ROOT, io.writes);
  let outputText: string;
  try {
    outputText = await readFile(outputPath, "utf-8");
  } catch {
    console.error(`  [${stageName}] claimed success but ${io.writes} does not exist.`);
    return { ...result, ok: false };
  }
  if (!hasRealContent(outputText)) {
    console.error(`  [${stageName}] claimed success but ${io.writes} is empty/header-only.`);
    return { ...result, ok: false };
  }

  return result;
}

/**
 * Should read docs/feedback_log.md, invoke the feedback-router agent via the
 * SDK, and parse its output into a FeedbackRouterDecision[] that the control
 * loop can act on (i.e. re-run decision.target_stage through the control loop).
 *
 * TODO(Phase 3+, once reviewer/testing-agent produce real feedback):
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

/**
 * Resolves the product idea: CLI args win, then an existing docs/idea.md.
 * Returns null if neither supplies one.
 */
async function resolveIdea(): Promise<string | null> {
  const fromArgv = process.argv.slice(2).join(" ").trim();
  if (fromArgv.length > 0) return fromArgv;
  return readIdeaDocBody();
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
    if (io !== undefined) console.log(`  ${io.writes}`);
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
      "want the new run to start from a clean slate."
  );
}

async function main(): Promise<void> {
  await loadDotEnv();

  const state0 = await loadState();

  // Resume/completion decisions happen BEFORE docs/idea.md is touched: a
  // finished run should not have its recorded idea overwritten by an argument
  // that is not going to be acted on.
  const firstStage = nextLinearStage(state0.stage);
  if (firstStage === null || STAGE_IO[firstStage] === undefined) {
    reportAlreadyComplete(state0, firstStage);
    if (process.argv.slice(2).join(" ").trim().length > 0) {
      console.log("");
      console.log("(The idea passed on the command line was NOT applied — nothing ran.)");
    }
    return;
  }

  const idea = await resolveIdea();
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
  if (state0.stage !== null) {
    console.log(`Resuming: last successful stage was "${state0.stage}", starting at "${firstStage}".`);
  }
  console.log("");

  let state = state0;
  let stage: PipelineStage | null = firstStage;
  let totalCostUsd = 0;

  while (stage !== null) {
    console.log(`==> ${stage}`);

    // Open the history entry before the agent runs, so a crash or a kill mid
    // stage leaves an honest "in-progress" record rather than no record.
    state = beginStage(state, stage);
    await saveState(state);

    const result = await runStage(stage);
    totalCostUsd += result.costUsd;

    if (result.ok) {
      state = finishStage(state, stage, "success");
      await saveState(state);
      console.log(
        `    ok — ${result.numTurns} turns, $${result.costUsd.toFixed(4)} ` +
          `(cumulative $${totalCostUsd.toFixed(4)})`
      );

      if (stage === LAST_IMPLEMENTED_STAGE) {
        console.log("");
        console.log(`Stopping at "${LAST_IMPLEMENTED_STAGE}" — end of Phase ${CURRENT_PHASE}.`);
        break;
      }
      stage = nextLinearStage(stage);
      continue;
    }

    // Failure: close the entry as a failure and persist that BEFORE recordRetry,
    // which throws past MAX_RETRIES_PER_STAGE and would otherwise take the
    // record of the final failed attempt down with it.
    state = finishStage(state, stage, "failure");
    await saveState(state);

    const attemptsUsed = (state.retries[stage] ?? 0) + 1;
    console.log(
      `    failed — ${result.numTurns} turns, $${result.costUsd.toFixed(4)} ` +
        `(cumulative $${totalCostUsd.toFixed(4)}); retry ${attemptsUsed} of ${MAX_RETRIES_PER_STAGE}`
    );

    try {
      state = recordRetry(state, stage);
    } catch (err) {
      console.log(`Total cost: $${totalCostUsd.toFixed(4)}`);
      throw err;
    }
    await saveState(state);
  }

  console.log(`Total cost: $${totalCostUsd.toFixed(4)}`);
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
