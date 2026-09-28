// orchestrator/run.ts
//
// Phase 5: the pipeline stops being a line and becomes a loop.
//
//   product-understanding -> product-alignment -> deep-discovery ->
//   design-planning -> architecture-planning -> implementation-planning ->
//   system-design -> low-level-design -> spec-implementer -> reviewer
//                                                              |
//                              feedback-router reads reviewer's findings and
//                              may send execution BACK to any earlier stage.
//
// Three things arrive with this phase:
//   1. `reviewer` — a document stage that reads the generated code as well as
//      the design docs, and writes evidence-bearing findings (F-n).
//   2. `feedback-router` — returns routing decisions as SDK STRUCTURED OUTPUT,
//      gated on confidence before any of them is allowed to spend money. See
//      orchestrator/router.ts for the gate and the research behind it.
//   3. the go-back loop below, with real caps: maxGoBacksPerRun, the cumulative
//      run budget, and a hard refusal to ever route forward.
//
// `critic` is implemented but is ON DEMAND ONLY (`--critic <target>`) and is
// deliberately not wired into this loop — auto-invoking it on a schedule is a
// later "Could" feature (M33) in the generated plan, not this phase.
//
// testing-agent is still unimplemented, and cannot ship before the sandbox
// (module M18) exists: it needs Playwright, i.e. a shell, and Decision LD-1
// forbids native Bash. See NOT_IMPLEMENTED_REASONS.
//
// spec-implementer (Phase 4) is the first stage that is not a document stage,
// and it broke four assumptions this file used to make. Each is generalised
// rather than special-cased on the stage name:
//   1. a stage wrote ONE document      -> StageIo.writes is a StageOutput union
//   2. hasRealContent() was the verifier -> per-output-kind verification
//   3. cwd was always PROJECT_ROOT     -> StageIo.cwd is "project" | "workspace"
//   4. the budget cap was per-query()  -> RunBudget caps the whole run

import { readFile, stat, writeFile } from "node:fs/promises";
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
  goBacksUsed,
  recordGoBack,
  recordRetry,
  rewindTo,
  MAX_RETRIES_PER_STAGE,
} from "./state.js";
import { PROJECT_ROOT, loadAgentDefinition } from "./agent-loader.js";
import { PIPELINE_STAGES } from "./types.js";
import { LAST_IMPLEMENTED_STAGE, NOT_IMPLEMENTED_REASONS } from "./stage-meta.js";
import type {
  AgentName,
  PipelineStage,
  FeedbackRouterDecision,
  RetryCounts,
  RoutingLogEntry,
  RunState,
  StageOutcome,
} from "./types.js";
import {
  DEFAULT_MAX_GO_BACKS_PER_RUN,
  ROUTER_OUTPUT_SCHEMA,
  parseRouterDecisions,
  planDrain,
} from "./router.js";
import { appendRoutingEntry, loadRoutingLog, nextRoutingDecisionId, routingLogPath } from "./routing.js";
import { MAX_BUDGET_USD_PER_RUN, RunBudget } from "./budget.js";
import { installWorkspaceDependencies } from "./deps.js";
import { loadModules } from "./modules.js";
import type { ModuleSpec } from "./modules.js";
import {
  PROGRESS_JSON,
  changedFiles,
  ensureWorkspace,
  existingWorkspaceFiles,
  snapshotWorkspace,
  typecheckWorkspace,
  workspaceRoot,
} from "./workspace.js";
import {
  appendProgress,
  appendRepair,
  checkLedgerProvenance,
  completedModuleIds,
  hashDocument,
  loadProgress,
  nextRepairId,
} from "./progress.js";
import type { LedgerIdentity, ProgressLog, RepairRecord } from "./progress.js";
import {
  buildRepairPrompt,
  describeTargetOwners,
  judgeRepair,
  ownersWithDiagnostics,
  selectRepairTargets,
  targetFiles,
} from "./repair.js";
import type { RepairTarget } from "./repair.js";
import { workspaceVcs } from "./vcs.js";
import type { WorkspaceCommit } from "./vcs.js";
import { parseReportedProgress, verifyModule } from "./verify.js";
import {
  baselineFrom,
  carryForwardBaseline,
  describeInheritedOwners,
  fileOwners,
  summariseInherited,
} from "./baseline.js";
import type { DiagnosticBaseline, InheritedDiagnostic } from "./baseline.js";
import {
  MAX_ATTEMPTS_PER_MODULE,
  failedAttemptCount,
  latestFailedAttempt,
} from "./retry-context.js";
import type { ModuleFailureRecord, PriorAttempt } from "./retry-context.js";
import { DOCS_DIR, IMPLEMENTER_DOC, buildModulePrompt } from "./module-prompt.js";
import {
  DeterministicStageFailure,
  EnvironmentalHalt,
  ModuleAttemptsExhausted,
  buildDeterministicHaltMessage,
  buildEnvironmentalHaltMessage,
  buildModuleExhaustedHaltMessage,
  classifyResult,
  describeEnvironmentalBlock,
  detectEnvironmentalBlock,
} from "./result-failure.js";
import type {
  ArtifactStatus,
  DeterministicFailure,
  EnvironmentalBlock,
} from "./result-failure.js";

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
 *
 * Raised again from $4.00 after a real run halted on it. Both calibrations so
 * far were measured against a 36-module plan; the cost of the document stages
 * scales with the number of modules they write about, and nothing caps how big
 * a plan an idea produces. Measured: low-level-design cost $2.86 for 36 modules,
 * and system-design hit $4.00 on a 53-module plan with a complete document
 * already written. Linear scaling puts a 53-module low-level-design near $4.20,
 * i.e. over the old cap before any variance.
 *
 * $8.00 is deliberate headroom rather than a tight fit, because a stage that
 * exceeds this now HALTS the run (see result-failure.ts) — being slightly too
 * low is expensive and disruptive, while being too high costs nothing unless a
 * stage actually runs away, and the cumulative run budget still bounds that.
 * It is not a prediction that any stage should cost $8.
 */
const MAX_BUDGET_USD_PER_STAGE = 8.0;

/**
 * Minimum headroom required to start another query(). An allowance of a few
 * cents buys a call that is guaranteed to die of `error_max_budget_usd`
 * partway through: money spent, nothing produced. Below this, halt cleanly.
 */
const MIN_BUDGET_HEADROOM_USD = 0.5;

/**
 * How many inherited (pre-existing, not-this-module's-fault) typecheck errors
 * to print per attempt before truncating. Every one of them is written to the
 * ledger regardless; this only bounds the console.
 */
const MAX_INHERITED_LOG_LINES = 5;

/**
 * Per-invocation spend cap for one `--repair` session.
 *
 * Lower than MAX_BUDGET_USD_PER_STAGE ($8) on purpose, and not out of caution:
 * the two calls are different sizes. A module call writes a whole module from a
 * specification; a repair opens a handful of existing files and changes a
 * handful of lines in them, with the entire job description pasted into the
 * prompt. The seven-error case that motivated this touches four files.
 *
 * It is also the one cap here that should bite rather than be generous
 * headroom. A repairer that has spent $3 has stopped making small edits to
 * named lines and started doing something else, and the right response to that
 * is to stop it and let a human look — the work is rolled back either way, so
 * an early cap costs the difference in tokens and nothing more.
 */
const MAX_BUDGET_USD_PER_REPAIR = 3.0;

/** `--repair`, named once so the parser, the messages and the README agree. */
const REPAIR_FLAG = "--repair";

/**
 * Sentinel for `--repair` given with no module id: repair everything
 * outstanding. It cannot be `null`, because null already means "the flag was
 * not passed at all", and those two have to stay distinguishable in CliArgs.
 */
const REPAIR_ALL = "__all__";

/**
 * How many modules one invocation may build.
 *
 * This was 2 through Phase 4: the first live runs of a loop that writes real
 * code had to be cheap enough to throw away, and a tiny cap was the crudest
 * reliable way to guarantee that. It has done that job. A 53-module plan built
 * two at a time is 27 invocations, and the cap stopped being a safety rail and
 * became the thing standing between the pipeline and a finished product.
 *
 * 54 is deliberately just past the current plan's 53, so the module cap is no
 * longer the governor of a normal run: MAX_BUDGET_USD_PER_RUN is. That is the
 * better governor, because it bounds the thing that actually matters (money)
 * rather than a proxy for it, and because it halts with `partial` — real work
 * recorded, nothing lost, re-run to continue — instead of truncating.
 *
 * The run budget is NOT raised to match. How much to spend is the human's
 * decision, and a long run stopping every $25 with a clear resume message is
 * the intended behaviour, not a limitation to engineer around.
 *
 * Modules already recorded complete in the workspace progress log are skipped,
 * so a second run continues rather than redoing. `--max-modules N` still
 * overrides this for anyone who wants the old small-bite behaviour.
 */
const DEFAULT_MAX_MODULES = 54;

/**
 * When this process started, as the ISO string the ledger's timestamps use.
 *
 * Read once so that "did this failure happen in THIS process or an earlier one"
 * has a single stable answer for the whole run (see latestFailedAttempt). The
 * distinction is not cosmetic: a retried module is told whether the files it is
 * repairing came from a session it remembers or one it does not.
 */
const PROCESS_STARTED_AT = new Date().toISOString();

/** The phase this build implements, used only for console/error wording. */
const CURRENT_PHASE = 5;

// LAST_IMPLEMENTED_STAGE and NOT_IMPLEMENTED_REASONS moved to
// ./stage-meta.ts so the local UI server can read them without importing the
// Agent SDK. They are re-exported below for anything that imported them here.

/**
 * Where docs/feedback_log.md lives — reviewer writes it, feedback-router reads
 * it, and nothing else touches it.
 */
const FEEDBACK_LOG_DOC = "docs/feedback_log.md";

/** Where an on-demand critic session is recorded. Appended, never rewritten. */
const CRITIC_LOG_DOC = "docs/critic_log.md";

/**
 * Coarse per-stage forecast used only by the go-back budget gate.
 *
 * It is a flat number rather than a model, and that is a deliberate choice over
 * the alternative in docs/lld.md §M27 ("the median of historicalStageCost per
 * stage times the stale fraction"): state/run.json does not record per-stage
 * cost, so there is no history to take a median of yet. $1.00 is taken from the
 * live figures in the README — Phase 1 cost ~$1.85 over three stages and Phase
 * 2 ~$2.28 over three — rounded up, because a forecast that is too low lets the
 * gate approve a go-back that dies partway through, which is the failure this
 * gate exists to prevent.
 */
const GO_BACK_DOC_STAGE_ESTIMATE_USD = 1.0;

/** Where the raw product idea is persisted so re-runs and agents can see it. */
const IDEA_DOC = "docs/idea.md";

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
  /**
   * Roots OTHER than `cwd` the stage needs to read, granted through the SDK's
   * `additionalDirectories`. reviewer is the first document stage that needs
   * one: it runs in the project (so it can write docs/feedback_log.md in
   * place) but has to read code that lives in a workspace outside this repo.
   */
  grants?: StageCwd[];
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
  // reviewer is a document stage that reads code. cwd stays "project" so it
  // writes docs/feedback_log.md in place; the workspace is granted read access
  // separately. Its tools are Read/Write/Grep/Glob — no Bash, so it cannot run
  // the code it is reviewing, only read it.
  reviewer: {
    reads: ["docs/design.md", IMPLEMENTER_DOC, "docs/lld.md"],
    writes: { kind: "document", path: FEEDBACK_LOG_DOC },
    cwd: "project",
    grants: ["workspace"],
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

/** Whether a stage can actually be run by this build. The router gate uses it. */
function isImplemented(stage: PipelineStage): boolean {
  return STAGE_IO[stage] !== undefined;
}

function stageIo(stage: PipelineStage): StageIo {
  const io = STAGE_IO[stage];
  if (io === undefined) {
    // Prefer the specific reason when there is one — "not implemented until
    // Phase 6+" is true of testing-agent but tells a human nothing about the
    // dependency that is actually blocking it.
    throw new Error(
      NOT_IMPLEMENTED_REASONS[stage] ??
        `Stage "${stage}" has no doc I/O mapping — not implemented until Phase ${phaseForStage(stage)}+.`
    );
  }
  return io;
}

/** Resolves a StageCwd to an absolute directory. */
function resolveRoot(where: StageCwd): string {
  return where === "workspace" ? workspaceRoot() : PROJECT_ROOT;
}

/** Resolves StageIo.cwd to an absolute directory. */
function resolveCwd(io: StageIo): string {
  return resolveRoot(io.cwd);
}

/** The absolute `additionalDirectories` a stage needs, or undefined for none. */
function resolveGrants(io: StageIo): string[] | undefined {
  if (io.grants === undefined || io.grants.length === 0) return undefined;
  return io.grants.map(resolveRoot);
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

/** `--accept-stage`, named once so the flag parser and the halt message agree. */
const ACCEPT_STAGE_FLAG = "--accept-stage";

/** The command a human would run to accept `stage`'s artifact as-is. */
function acceptCommandFor(stage: PipelineStage): string {
  return `npm run orchestrator -- ${ACCEPT_STAGE_FLAG} ${stage}`;
}

/** "31KB", for a human eyeballing whether a cap was calibrated for this run. */
function kb(bytes: number): string {
  return `${Math.round(bytes / 1024)}KB`;
}

/**
 * How big the documents this stage reads actually are. Printed on a budget
 * halt because MAX_BUDGET_USD_PER_STAGE was calibrated against a much smaller
 * plan, and the input size is the thing that moved — a human picking a new cap
 * needs to see it rather than guess.
 */
async function describeInputs(reads: string[]): Promise<string> {
  const parts: string[] = [];
  for (const rel of reads) {
    try {
      const text = await readFile(path.join(PROJECT_ROOT, rel), "utf-8");
      parts.push(`${rel} ${kb(Buffer.byteLength(text, "utf-8"))}`);
    } catch {
      parts.push(`${rel} (missing)`);
    }
  }
  return parts.length > 0 ? parts.join(" + ") : "none";
}

/**
 * Whether a document stage's output is there and real — the SAME check the
 * success path in runDocumentStage applies, deliberately so: a cap failure that
 * produced a good document must be reported with the same authority as a
 * success, without being promoted to one.
 */
async function inspectDocumentArtifact(io: StageIo, outputRelPath: string): Promise<ArtifactStatus> {
  let text: string;
  try {
    text = await readFile(path.join(PROJECT_ROOT, outputRelPath), "utf-8");
  } catch {
    return {
      description: outputRelPath,
      complete: false,
      detail: "the file does not exist, so this call produced nothing.",
    };
  }
  if (!hasRealContent(text)) {
    return {
      description: outputRelPath,
      complete: false,
      detail: `${Buffer.byteLength(text, "utf-8")} bytes, but header/placeholder only — no real content.`,
    };
  }

  const flat = text.replace(/\s+/g, " ").trim();
  const tail = flat.length > 70 ? `...${flat.slice(-70)}` : flat;
  return {
    description: outputRelPath,
    complete: true,
    detail:
      `${kb(Buffer.byteLength(text, "utf-8"))} of real content, ending: "${tail}". ` +
      `Inputs read: ${await describeInputs(io.reads)}.`,
  };
}

/**
 * Whether the workspace stage's output is complete: every module in the plan
 * recorded as built in a ledger that provably belongs to THIS plan. Anything
 * less is a half-built workspace, which must not be accepted as a finished
 * stage — later stages would read it as if every module existed.
 */
async function inspectWorkspaceArtifact(moduleDoc: string): Promise<ArtifactStatus> {
  const description = `${workspaceRoot()}/ (modules from ${moduleDoc})`;
  try {
    const modules = await loadModules(moduleDoc);
    const provenance = checkLedgerProvenance(await loadProgress(), await currentLedgerIdentity());
    if (!provenance.ok) return { description, complete: false, detail: provenance.message };

    const completed = completedModuleIds(provenance.log);
    const remaining = modules.filter((module) => !completed.has(module.id));
    if (remaining.length > 0) {
      return {
        description,
        complete: false,
        detail:
          `${completed.size} of ${modules.length} modules built; still to build: ` +
          `${remaining.slice(0, 8).map((m) => m.id).join(", ")}${remaining.length > 8 ? ", ..." : ""}`,
      };
    }
    return {
      description,
      complete: true,
      detail: `all ${modules.length} modules recorded complete in the workspace progress ledger.`,
    };
  } catch (err) {
    return {
      description,
      complete: false,
      detail: `could not be verified: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/** Dispatches on the KIND of output, exactly as the run loop does. */
async function inspectStageArtifact(io: StageIo): Promise<ArtifactStatus> {
  return io.writes.kind === "document"
    ? inspectDocumentArtifact(io, io.writes.path)
    : inspectWorkspaceArtifact(io.writes.moduleDoc);
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
  // reviewer is the only document stage that also reads code, and the code is
  // not under its cwd — it has to be told where the granted directory is.
  const extra =
    io.grants?.includes("workspace") === true
      ? [
          `The generated code you are reviewing is at ${workspaceRoot()} (granted read-only). ` +
            `Use Glob and Grep there rather than reading the whole tree; it may be large, and ` +
            `${workspaceRoot()}/PROGRESS.md lists which modules have actually been built so far.`,
        ]
      : [];

  return [
    `You are running as the "${stage}" stage of an automated product-development pipeline.`,
    reads,
    ...extra,
    `Write your output to ${outputPath}, replacing any placeholder content but keeping the existing HTML comment header line at the top of the file.`,
    `The file must end up with substantive markdown content — an empty or header-only file counts as a failed stage.`,
    `Work autonomously: there is no human to ask, so record open questions and assumptions in your output rather than stopping to ask them.`,
    `When you are done, reply with a one-paragraph summary of what you wrote.`,
  ].join("\n\n");
}

interface QueryOutcome {
  ok: boolean;
  text: string;
  costUsd: number;
  numTurns: number;
  /**
   * `SDKResultSuccess.structured_output`, passed through verbatim and still
   * typed `unknown`. It is only populated when the call set `outputFormat`, and
   * even then schema-constrained decoding is a strong constraint rather than a
   * guarantee — so it is validated at the call site (parseRouterDecisions)
   * rather than being trusted here.
   */
  structuredOutput: unknown;
  /**
   * Set when the call died on a cap that an identical re-run would hit again
   * (see orchestrator/result-failure.ts). The caller must HALT rather than
   * retry; `ok: false` alone does not say which kind of failure this was, and
   * treating all of them as retryable is what made one live run pay four times
   * for a document that was already complete after the first attempt.
   */
  deterministic: DeterministicFailure | null;
  /**
   * Set when the call was blocked by the ENVIRONMENT rather than by anything in
   * this run: the account's usage/session/rate limit, or the CLI refusing to
   * skip permission prompts because the process is running as root. The caller
   * must halt without recording an attempt — the agent never ran, so charging
   * the module for it (which happened to M05 three times on one live run, and
   * to M24 three times on another) blames the code for the environment and
   * leaves the next run with no budget to resume on.
   */
  environmental: EnvironmentalBlock | null;
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
  stageName: AgentName,
  prompt: string,
  extra: {
    cwd: string;
    maxBudgetUsd: number;
    additionalDirectories?: string[];
    /**
     * A JSON schema for structured output. Set only by the feedback-router
     * call: its result is consumed programmatically to decide how to spend
     * money, and scraping that out of prose is not an option.
     */
    outputSchema?: Record<string, unknown>;
  }
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
  if (extra.outputSchema !== undefined) {
    options.outputFormat = { type: "json_schema", schema: extra.outputSchema };
  }

  const assistantText: string[] = [];
  let outcome: QueryOutcome = {
    ok: false,
    text: "",
    costUsd: 0,
    numTurns: 0,
    structuredOutput: undefined,
    deterministic: null,
    environmental: null,
  };
  let sawResultMessage = false;

  try {
    for await (const message of query({ prompt, options })) {
      collectAssistantText(message, assistantText);
      if (message.type !== "result") continue;

      sawResultMessage = true;
      const classification = classifyResult(message);
      outcome = {
        ok: classification.kind === "success",
        text: message.subtype === "success" ? message.result : assistantText.join("\n"),
        costUsd: message.total_cost_usd,
        numTurns: message.num_turns,
        structuredOutput: message.subtype === "success" ? message.structured_output : undefined,
        deterministic: classification.kind === "deterministic" ? classification.failure : null,
        environmental: classification.kind === "environmental" ? classification.block : null,
      };
      if (classification.kind === "environmental") {
        console.error(
          `  [${label}] blocked by the environment (${describeEnvironmentalBlock(classification.block)}) ` +
            `— NOT retrying and NOT counting this as an attempt.`
        );
      } else if (classification.kind === "deterministic") {
        console.error(
          `  [${label}] SDK result hit a deterministic cap: ${classification.failure.subtype} — ` +
            `NOT retrying, an identical re-run would hit the same cap.`
        );
      } else if (classification.kind === "transient") {
        console.error(`  [${label}] SDK result was not a success: ${classification.subtype}`);
      }
    }
  } catch (err) {
    // A thrown SDK error is transient by default: it never carried a result
    // subtype, so there is nothing to classify and the retry budget applies.
    const detail = err instanceof Error ? err.message : String(err);
    // ...unless it is an environmental block. The CLI surfaces both kinds as a
    // thrown error rather than as a result message — "Claude Code returned an
    // error result: You've hit your session limit · resets ...", and "Claude
    // Code process exited with code 1. stderr: --dangerously-skip-permissions
    // cannot be used with root/sudo privileges for security reasons" — so this
    // is the path that actually sees them. detectEnvironmentalBlock returns
    // null when unsure, which leaves the pre-existing transient behaviour
    // exactly as it was.
    const environmental = detectEnvironmentalBlock(detail);
    if (environmental !== null) {
      console.error(
        `  [${label}] blocked by the environment (${describeEnvironmentalBlock(environmental)}) — ` +
          `NOT retrying and NOT counting this as an attempt.`
      );
    } else {
      console.error(`  [${label}] SDK call threw: ${detail}`);
    }
    return { ...outcome, ok: false, text: detail, deterministic: null, environmental };
  }

  if (!sawResultMessage) {
    console.error(
      `  [${label}] the SDK stream ended without a result message — treating as a failed attempt.`
    );
  }
  return outcome;
}

/**
 * Halts the run when a call was blocked by the environment: the account's usage
 * limit, or the CLI refusing to skip permission prompts under root.
 *
 * The third category alongside the two that already existed: a fatal config
 * fault throws, a transient SDK error is retried, and an ENVIRONMENTAL BLOCK
 * halts without being charged to anything. Called immediately after every
 * query(), before any verification, ledger write or retry decision, because
 * the whole point is that no record of an attempt is made.
 */
function haltIfEnvironmentalBlock(label: string, outcome: QueryOutcome): void {
  if (outcome.environmental === null) return;
  throw new EnvironmentalHalt(
    buildEnvironmentalHaltMessage({
      label,
      block: outcome.environmental,
      costUsd: outcome.costUsd,
    }),
    outcome.environmental
  );
}

/** A stage whose whole job is one markdown file — the Phase 1-3 shape, unchanged. */
async function runDocumentStage(
  stageName: PipelineStage,
  io: StageIo,
  outputRelPath: string,
  definition: AgentDefinition,
  budget: RunBudget
): Promise<StageResult> {
  const additionalDirectories = resolveGrants(io);
  // A granted directory that does not exist is rejected by the SDK, and the
  // workspace legitimately may not exist yet on a run that reached reviewer
  // without building anything. Bootstrapping is idempotent, so this is safe.
  if (io.grants?.includes("workspace") === true) await ensureWorkspace();

  const allowanceUsd = budget.allowanceFor(MAX_BUDGET_USD_PER_STAGE);
  const outcome = await runQueryOnce(
    stageName,
    definition,
    stageName,
    buildDocumentPrompt(stageName, io, outputRelPath),
    {
      cwd: resolveCwd(io),
      maxBudgetUsd: allowanceUsd,
      ...(additionalDirectories !== undefined ? { additionalDirectories } : {}),
    }
  );
  budget.record(outcome.costUsd);
  haltIfEnvironmentalBlock(stageName, outcome);

  // A cap failure is fatal, not retryable — the same idiom runStage already
  // uses for configuration faults. Before halting, LOOK AT WHAT WAS WRITTEN:
  // the stage may well have finished the document and then run out of cap on a
  // later turn, which is precisely the case that used to be thrown away.
  if (outcome.deterministic !== null) {
    throw new DeterministicStageFailure(
      buildDeterministicHaltMessage({
        label: stageName,
        failure: outcome.deterministic,
        costUsd: outcome.costUsd,
        numTurns: outcome.numTurns,
        allowanceUsd,
        perStageCapUsd: MAX_BUDGET_USD_PER_STAGE,
        artifact: await inspectDocumentArtifact(io, outputRelPath),
        acceptCommand: acceptCommandFor(stageName),
      }),
      outcome.deterministic.subtype
    );
  }

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
 * The identity a ledger written by THIS run would carry: a hash of the plan the
 * modules come from, plus the idea, for a human reading the file.
 */
async function currentLedgerIdentity(): Promise<LedgerIdentity> {
  const planText = await readFile(path.join(PROJECT_ROOT, IMPLEMENTER_DOC), "utf-8");
  const planHash = hashDocument(planText);
  if (planHash === null) {
    throw new Error(
      `${IMPLEMENTER_DOC} is empty, so the progress ledger cannot be tied to a plan. ` +
        `Run the implementation-planning stage first.`
    );
  }
  return { planHash, ideaHash: hashDocument(await readIdeaDocBody()) };
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
 * A module that fails is retried IN PLACE, up to MAX_ATTEMPTS_PER_MODULE
 * attempts, each one told exactly what the previous one broke. The budget is
 * per-module and counted in the workspace ledger, not the stage retry counter in
 * state/run.json: this stage is one call per module over a whole plan, so
 * charging module failures to the stage would let three bad modules out of 53
 * end the build — permanently, since that counter is persisted.
 *
 * When a module uses up its own budget the STAGE halts rather than moving on:
 * later modules import earlier ones, so continuing past a broken module buys a
 * cascade of failures at full price. See buildModuleExhaustedHaltMessage for
 * what the human is told at that point.
 */
/**
 * What the previous failed attempt at `moduleId` left behind, or null if there
 * was no previous failed attempt.
 *
 * The ledger is the source of truth rather than an in-memory map, because the
 * two situations that need this are (a) a stage retry inside one process and
 * (b) a re-run in a NEW process after the run was stopped — and only the ledger
 * spans both. See ModuleProgressEntry.failure for why that is the right call.
 *
 * The recorded file list is re-checked against disk before it is promised to
 * the agent. A ledger entry says what WAS written; only `stat` says what is
 * still there.
 */
async function priorAttemptFor(progress: ProgressLog, moduleId: string): Promise<PriorAttempt | null> {
  const prior = latestFailedAttempt(progress.entries, moduleId, PROCESS_STARTED_AT);
  if (prior === null) return null;

  const present = await existingWorkspaceFiles(prior.filesWritten);
  return {
    ...prior,
    filesWritten: present,
    filesVanished: prior.filesWritten.length > 0 && present.length === 0,
  };
}

/**
 * Everything the "this module used up its attempts" halt needs, read out of the
 * ledger rather than tracked in memory — the count, the last diagnostics and the
 * files all come from the same place, so a halt on attempt 3 of a resumed run
 * says exactly what a halt on attempt 3 of one long run says.
 */
async function moduleExhaustedHalt(
  stageName: PipelineStage,
  spec: ModuleSpec,
  position: number,
  modules: readonly ModuleSpec[],
  progress: ProgressLog,
  attemptsUsed: number,
  completed: ReadonlySet<string>
): Promise<ModuleAttemptsExhausted> {
  // Non-null in practice: attemptsUsed > 0 means the module's latest entry is a
  // failure, which is exactly when priorAttemptFor returns a record. The
  // fallback exists so a halt message can never be the thing that crashes.
  const prior = await priorAttemptFor(progress, spec.id);
  const costUsd = progress.entries
    .filter((entry) => entry.moduleId === spec.id)
    .reduce((total, entry) => total + entry.costUsd, 0);

  const message = buildModuleExhaustedHaltMessage({
    stage: stageName,
    moduleId: spec.id,
    moduleTitle: spec.title,
    position,
    moduleCount: modules.length,
    attemptsUsed,
    maxAttempts: MAX_ATTEMPTS_PER_MODULE,
    costUsd,
    failure: prior?.record ?? {
      kind: "sdk",
      reason: "the last attempt was recorded as a failure with no structured detail",
      typecheckErrors: [],
      stubFindings: [],
      unownedReqs: [],
    },
    filesWritten: prior?.filesWritten ?? [],
    workspaceRoot: workspaceRoot(),
    ledgerPath: path.join(workspaceRoot(), PROGRESS_JSON),
    notAttempted: modules
      .filter((module) => module.id !== spec.id && !completed.has(module.id))
      .map((module) => module.id),
  });
  return new ModuleAttemptsExhausted(message, spec.id);
}

/**
 * The end-of-stage accounting for errors nobody was failed for.
 *
 * Not failing a module for code it did not write is right. Leaving the code
 * broken and unmentioned is not: an error that fails nobody and is reported to
 * nobody never gets fixed. So the ones still outstanding are counted out loud,
 * with the module that owns each file, because somebody has to decide to fix
 * them and the pipeline's job here is to make that decision visible rather than
 * to hide it or to bill it to the wrong module.
 */
function reportInheritedAtStageEnd(inherited: readonly InheritedDiagnostic[]): void {
  if (inherited.length === 0) {
    console.log("  inherited typecheck errors outstanding at end of stage: none");
    return;
  }

  const byOwner = summariseInherited(inherited);
  const files = new Set(inherited.map((item) => item.file)).size;
  console.log(
    `  inherited typecheck errors outstanding at end of stage: ${inherited.length} across ` +
      `${files} file(s), owned by ${byOwner.length} module(s)`
  );
  for (const owner of byOwner) {
    console.log(
      `    ${owner.owner ?? "(unattributed — no ledger entry claims these files)"}: ` +
        `${owner.diagnostics} error(s) in ${owner.files.length} file(s) — ${owner.files.join(", ")}`
    );
  }
  console.log(
    `    these failed no module and are recorded per attempt in ${PROGRESS_JSON} ` +
      `(entries[].inheritedDiagnostics); the reviewer stage can act on them`
  );
}

/** Does this path exist? Used for one "were the types actually installed" check. */
async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

async function runModuleStage(
  stageName: PipelineStage,
  definition: AgentDefinition,
  budget: RunBudget,
  maxModules: number,
  installDeps: boolean
): Promise<StageResult> {
  const bootstrap = await ensureWorkspace();
  console.log(`  workspace: ${bootstrap.root}`);
  if (bootstrap.created.length > 0) {
    console.log(`  bootstrapped: ${bootstrap.created.join(", ")}`);
  }

  const modules = await loadModules(IMPLEMENTER_DOC);

  // Before anything is skipped OR spent: prove the ledger in this workspace was
  // built from THIS plan. Module ids are positional, so a stale ledger from a
  // different product would silently mark M01-Mnn complete and ship its code as
  // this product's. The check is free and happens before the first query().
  const identity = await currentLedgerIdentity();
  const loaded = await loadProgress();
  // THROWS rather than returning a failed StageResult: a ledger from another
  // product is a configuration fault, and the retry loop would just print the
  // same refusal three more times before halting anyway.
  const provenance = checkLedgerProvenance(loaded, identity);
  if (!provenance.ok) throw new Error(provenance.message);

  let progress: ProgressLog = provenance.log;
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

  // THE BOOTSTRAP INSTALL — before the first module's call, not after it.
  //
  // The workspace declares `@types/node` for itself at bootstrap (see
  // workspaceTsconfig: that declaration is what lets the committed tsconfig keep
  // `typeRoots` relative instead of naming a path inside THIS repo). A
  // declaration is not a type: until something installs it, `process`, `Buffer`
  // and `console` are TS2304 in every generated file.
  //
  // The per-module install runs AFTER a module's call, which is right for
  // dependencies that module just declared and too late for this one — module 1
  // would be verified against a workspace with no Node types and fail for a
  // reason it did not cause. Hence one install here, before anything is built.
  // It is the same hash-gated function, so once the declared set is installed
  // the per-module calls report "unchanged" and cost nothing; this adds one npm
  // call to a cold workspace and none to a warm one.
  const bootstrapDeps = await installWorkspaceDependencies({ enabled: installDeps });
  for (const line of bootstrapDeps.log) console.log(`  ${line}`);
  if (!(await pathExists(path.join(bootstrap.root, "node_modules", "@types", "node")))) {
    // Loud rather than fatal, and specific about the symptom, because this is
    // the one state in which every module fails identically for something no
    // module did: --no-install, no network, or a registry that said no.
    console.warn(
      `  [deps] WARNING: @types/node is declared but not installed in ${bootstrap.root}. ` +
        `Generated code using process/Buffer/console will fail the typecheck with TS2304 ` +
        `"cannot find name", and that is the environment, not the module. Run ` +
        `\`npm install --ignore-scripts\` in the workspace (or drop --no-install) before ` +
        `trusting a module failure.`
    );
  }

  // THE TYPECHECK BASELINE — see orchestrator/baseline.ts for the incident.
  //
  // Captured ONCE here, then carried forward: the post-verification typecheck
  // of module N is the pre-call state of module N+1, so the whole stage pays
  // for exactly one extra `tsc` run rather than doubling them. It is taken
  // AFTER the "nothing pending" early return, so a fully-built workspace pays
  // for nothing at all.
  let baseline: DiagnosticBaseline = baselineFrom(await typecheckWorkspace(), "stage start");
  console.log(
    `  typecheck baseline: ${baseline.size} pre-existing diagnostic(s) in the workspace at stage ` +
      `start; no module will be failed for these unless it touches their file`
  );
  // The inherited set as of the most recent attempt — i.e. what is still
  // outstanding — for the end-of-stage summary.
  let outstandingInherited: InheritedDiagnostic[] = [];

  // Labelled because the inner per-attempt loop needs to be able to stop the
  // whole STAGE: the --max-modules cap and the run budget end the stage, while a
  // failed verification only ends one attempt at one module.
  moduleLoop: for (const spec of pending) {
    if (built >= maxModules) {
      notes.push(`stopped at the --max-modules cap of ${maxModules}`);
      break;
    }

    const position = modules.findIndex((m) => m.id === spec.id) + 1;
    console.log(`  --> ${spec.id} ${spec.title} (module ${position} of ${modules.length})`);

    // ONE module, up to MAX_ATTEMPTS_PER_MODULE attempts at it, retried HERE.
    //
    // The retry used to happen one level up: a module failure returned
    // `outcome: "failure"`, main() called recordRetry(stage) and re-entered this
    // function, which re-derived the pending list and carried on. That gave the
    // right behaviour for one module and the wrong budget for a plan — three
    // failures spread anywhere across 53 modules exhausted
    // MAX_RETRIES_PER_STAGE for the entire build, and because state.retries is
    // persisted, every later run then halted on its first failure. Retrying in
    // place means a module failure never touches the stage counter, which stays
    // as the runaway guard for stage-LEVEL faults.
    let moduleBuilt = false;
    while (!moduleBuilt) {
      if (!budget.canAfford(MIN_BUDGET_HEADROOM_USD)) {
        notes.push(
          `stopped before ${spec.id}: only $${budget.remaining.toFixed(4)} left of the ` +
            `$${budget.cap.toFixed(2)} run budget, below the $${MIN_BUDGET_HEADROOM_USD.toFixed(2)} minimum`
        );
        aggregate.budgetHalt = true;
        break moduleLoop;
      }

      // From the LEDGER, not from a loop variable: that is what makes the budget
      // mean the same thing for three attempts in one process and for three
      // attempts spread over three resumed runs against the same workspace.
      const attemptsUsed = failedAttemptCount(progress.entries, spec.id);
      if (attemptsUsed >= MAX_ATTEMPTS_PER_MODULE) {
        // Halts the stage instead of moving to the next module. The plan is
        // dependency-ordered and later modules import this one, so continuing
        // past it buys a cascade of failures at full price.
        throw await moduleExhaustedHalt(
          stageName,
          spec,
          position,
          modules,
          progress,
          attemptsUsed,
          completed
        );
      }

      // Everything the previous failed attempt at THIS module knew, recovered
      // from the ledger rather than from memory. That is what makes it work
      // identically for a retry inside this loop and for a fresh process
      // resuming after a halt.
      const prior = await priorAttemptFor(progress, spec.id);
      if (prior !== null) {
        console.log(
          `      retry: attempt ${attemptsUsed + 1} of ${MAX_ATTEMPTS_PER_MODULE}, informed by ` +
            `the ${prior.record.kind} failure recorded ` +
            `${prior.crossProcess ? "by an earlier process" : "earlier in this run"} ` +
            `(${prior.filesWritten.length} file(s) of its output still present)`
        );
      }

      const startedAt = new Date().toISOString();
      const before = await snapshotWorkspace();

      const allowanceUsd = budget.allowanceFor(MAX_BUDGET_USD_PER_STAGE);
      const outcome = await runQueryOnce(
        `${stageName}/${spec.id}`,
        definition,
        stageName,
        buildModulePrompt(spec, position, modules.length, [...completed], prior),
        {
          cwd: workspaceRoot(),
          maxBudgetUsd: allowanceUsd,
          // The design docs live outside the workspace cwd; this is what makes
          // them readable at all. They are still instructed to be read-only.
          additionalDirectories: [DOCS_DIR],
        }
      );
      budget.record(outcome.costUsd);
      // BEFORE the snapshot, the typecheck and the ledger write: an
      // environmental block means the agent never ran, so there is no attempt
      // to record and nothing to verify. Recording one here is the bug this
      // guard exists for — it cost M05 and M24 their whole attempt budgets on
      // two separate live runs.
      haltIfEnvironmentalBlock(`${stageName}/${spec.id}`, outcome);
      aggregate.costUsd += outcome.costUsd;
      aggregate.numTurns += outcome.numTurns;

      const after = await snapshotWorkspace();
      const written = changedFiles(before, after);
      const reported = parseReportedProgress(outcome.text);

      // Dependencies FIRST, then the typecheck. This is the moment package.json
      // may have just gained entries, and a `tsc` run against a workspace whose
      // imports cannot resolve checks almost nothing in the files that matter.
      // Never fatal: `installWorkspaceDependencies` does not throw, and a failed
      // install just leaves unresolved imports as warnings, exactly as before.
      const deps = await installWorkspaceDependencies({ enabled: installDeps });
      for (const line of deps.log) console.log(`      ${line}`);

      // The typecheck runs whatever the SDK said, because "the model reported an
      // error" and "the code it already wrote is broken" are different facts, and
      // the second one is the one that has to be recorded.
      const typecheck = await typecheckWorkspace();
      // `deps.status === "installed"` is the trap, named explicitly: an install
      // that ACTUALLY RAN this attempt has just made files visible to tsc that
      // were hidden behind TS2307 a moment ago, and every error inside them
      // would otherwise land on this module. "unchanged" and "disabled" changed
      // nothing on disk and get no such allowance.
      const installRan = deps.status === "installed";
      if (installRan) {
        console.log(
          `      baseline: a dependency install ran during this attempt, so errors newly visible ` +
            `in the ${baseline.importBlockedFiles.size} file(s) whose imports were previously ` +
            `unresolved are treated as pre-existing, not as ${spec.id}'s`
        );
      }
      // The second door into the same trap. Re-deriving the workspace tsconfig
      // (deps.ts, when the declared dependency set changes what the config
      // should be) changes the diagnostic set for every file at once, exactly as
      // an install does. Only an actual REWRITE counts; a re-derivation that
      // produced identical content changed nothing and buys no allowance.
      const tsconfigRewritten = deps.tsconfigRewritten;
      if (tsconfigRewritten) {
        console.log(
          `      baseline: the workspace tsconfig was re-derived for a "${deps.tsconfigRuntime}" ` +
            `product and rewritten during this attempt, so errors newly visible in files ` +
            `${spec.id} did not touch are treated as pre-existing, not as its`
        );
      }
      const verification = await verifyModule(spec, written, reported, typecheck, deps, {
        baseline,
        installRan,
        tsconfigRewritten,
        // Built from the ledger written so far: filesWritten is what makes
        // "who owns this file" answerable at all.
        owners: fileOwners(progress.entries),
      });

      // Carried forward whether the module passed or failed, and BEFORE the
      // `continue` that starts the next attempt.
      baseline = carryForwardBaseline(
        typecheck,
        verification.typecheckErrors,
        `after ${spec.id} attempt ${attemptsUsed + 1}`
      );
      outstandingInherited = verification.inherited;

      if (verification.inherited.length > 0) {
        console.log(
          `      inherited: ${verification.inherited.length} pre-existing typecheck error(s) in ` +
            `files ${spec.id} did not write — NOT its fault and not counted against it ` +
            `(owners: ${describeInheritedOwners(verification.inherited)})`
        );
        for (const item of verification.inherited.slice(0, MAX_INHERITED_LOG_LINES)) {
          console.log(
            `        [${item.reason}, owner ${item.owner ?? "unattributed"}] ${item.diagnostic}`
          );
        }
        if (verification.inherited.length > MAX_INHERITED_LOG_LINES) {
          console.log(
            `        ...and ${verification.inherited.length - MAX_INHERITED_LOG_LINES} more ` +
              `(all of them recorded in ${PROGRESS_JSON})`
          );
        }
      }

      const sdkFailure = outcome.ok ? null : `the SDK call did not succeed: ${outcome.text.slice(0, 300)}`;
      const failureReason = sdkFailure ?? verification.failureReason;
      const moduleOk = failureReason === null;

      // Structured, so the NEXT attempt can be told what to repair. Built here
      // rather than in the verifier because the SDK-level failure is only known
      // at this level, and it has to be one of the kinds too — a call that died
      // mid-write still left files behind that the next attempt must not
      // duplicate.
      const failureRecord: ModuleFailureRecord | undefined = moduleOk
        ? undefined
        : {
            kind: sdkFailure !== null ? "sdk" : (verification.failureKind ?? "sdk"),
            reason: failureReason,
            // verification.typecheckErrors, NOT typecheck.errors: it is the set
            // that actually counted, i.e. the real diagnostics plus the TS2307
            // lines promoted to errors because the packages were installed and
            // the import was therefore undeclared. Do not "helpfully" add
            // typecheck.missingModuleWarnings back when no install succeeded:
            // forty unresolved-import lines around one real TS2322 is how the
            // real error gets ignored.
            typecheckErrors: [...verification.typecheckErrors],
            stubFindings: verification.stub.findings.map(
              (finding) => `${finding.file}:${finding.line} — ${finding.label}: ${finding.text}`
            ),
            unownedReqs: [...verification.unownedReqs],
          };

      progress = await appendProgress(progress, {
        moduleId: spec.id,
        title: spec.title,
        startedAt,
        finishedAt: new Date().toISOString(),
        outcome: moduleOk ? "success" : "failure",
        filesWritten: written,
        reqsClaimed: verification.reqsClaimed,
        failureReason,
        ...(failureRecord === undefined ? {} : { failure: failureRecord }),
        ...(verification.inherited.length === 0
          ? {}
          : { inheritedDiagnostics: verification.inherited }),
        deviations: reported.deviations,
        warnings: verification.warnings,
        costUsd: outcome.costUsd,
        numTurns: outcome.numTurns,
      });

      for (const warning of verification.warnings) console.log(`      warning: ${warning}`);

      if (!moduleOk) {
        console.error(
          `      FAILED (attempt ${attemptsUsed + 1} of ${MAX_ATTEMPTS_PER_MODULE}) — ${failureReason}`
        );

        // Same split as the document stages, with the module's own verification
        // standing in for hasRealContent: the code this call wrote may be
        // complete and typecheck-clean even though the call itself hit its cap.
        // The progress entry above is already written either way, so the
        // evidence survives the halt.
        if (outcome.deterministic !== null) {
          const artifactOk = verification.failureReason === null && written.length > 0;
          throw new DeterministicStageFailure(
            buildDeterministicHaltMessage({
              label: `${stageName}/${spec.id}`,
              failure: outcome.deterministic,
              costUsd: outcome.costUsd,
              numTurns: outcome.numTurns,
              allowanceUsd,
              perStageCapUsd: MAX_BUDGET_USD_PER_STAGE,
              artifact: {
                description: `${spec.id} in ${workspaceRoot()}/`,
                complete: artifactOk,
                detail: artifactOk
                  ? `${written.length} file(s) written and they pass the module verification ` +
                    `(REQs ${verification.reqsClaimed.join(", ") || "none"}, typecheck clean). ` +
                    `Recorded as a FAILED attempt in the workspace progress ledger.`
                  : (verification.failureReason ?? `${written.length} file(s) written.`),
              },
              // There is no --accept-stage for one module of a multi-module
              // stage: the stage is not finished, so accepting it would claim
              // modules that were never built.
              acceptCommand: null,
            }),
            outcome.deterministic.subtype
          );
        }

        // Not a stage failure and not a reason to move on: go round the while
        // loop and attempt THIS module again, with the failure just recorded in
        // the ledger now driving the next prompt. The budget check at the top is
        // what ends it, either by halting (attempts used up) or by stopping the
        // stage cleanly (run budget).
        continue;
      }

      built += 1;
      moduleBuilt = true;
      completed.add(spec.id);
      console.log(
        `      ok — ${written.length} file(s), ${verification.reqsClaimed.length} REQ(s), ` +
          `$${outcome.costUsd.toFixed(4)}`
      );
    }
  }

  reportInheritedAtStageEnd(outstandingInherited);

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
  maxModules: number = DEFAULT_MAX_MODULES,
  installDeps: boolean = true
): Promise<StageResult> {
  const io = stageIo(stageName);
  const definition = await loadAgentDefinition(stageName);

  if (io.writes.kind === "document") {
    return runDocumentStage(stageName, io, io.writes.path, definition, budget);
  }
  return runModuleStage(stageName, definition, budget, maxModules, installDeps);
}

/**
 * What one drain of the feedback-router produced.
 *
 * `ok: false` with `decisions: []` is a clean failure, never a crash: the two
 * ways this call goes wrong (the SDK call itself failed, or the structured
 * output did not validate) both leave the run in a state where the only safe
 * move is to stop and tell a human, and neither should take the process down.
 */
interface RouterRunResult {
  ok: boolean;
  error: string | null;
  decisions: FeedbackRouterDecision[];
  costUsd: number;
  numTurns: number;
}

/**
 * Reads docs/feedback_log.md and returns the router's decisions.
 *
 * The decisions arrive as SDK STRUCTURED OUTPUT (`options.outputFormat` with a
 * json_schema; the result lands on `SDKResultSuccess.structured_output`).
 * Nothing is parsed out of prose here, and there is no regex fallback — a
 * fallback would mean the malformed case silently produces *something*, and
 * what this function returns is an instruction to spend money re-running
 * stages. `structured_output` is typed `unknown` by the SDK and is validated
 * against the expected shape by parseRouterDecisions() regardless.
 *
 * `RD-n` ids are allocated HERE, from the routing log, not by the agent
 * (docs/lld.md §base: monotonic per project, max existing id + 1).
 */
async function invokeFeedbackRouter(
  budget: RunBudget,
  originStage: PipelineStage
): Promise<RouterRunResult> {
  const definition = await loadAgentDefinition("feedback-router");

  const prompt = [
    `You are the feedback-router for an automated product-development pipeline.`,
    `Read ${FEEDBACK_LOG_DOC} (relative to the current working directory). It holds the findings ` +
      `written by the "${originStage}" stage, each with an F-n id, a severity and its evidence.`,
    `The feedback was produced BY the "${originStage}" stage, so every target_stage you name must ` +
      `be EARLIER than "${originStage}" in the pipeline order. A decision naming "${originStage}" ` +
      `or anything after it is rejected as a contract violation and wastes the call.`,
    `Check each finding's evidence against the upstream documents before you rate your confidence ` +
      `in it — you have Read and Grep for exactly that.`,
    `Return your decisions as structured output matching the schema you were given. Emit no ` +
      `decision at all for findings that do not warrant re-running a stage; an empty array is a ` +
      `valid answer.`,
  ].join("\n\n");

  const allowanceUsd = budget.allowanceFor(MAX_BUDGET_USD_PER_STAGE);
  const outcome = await runQueryOnce("feedback-router", definition, "feedback-router", prompt, {
    cwd: PROJECT_ROOT,
    maxBudgetUsd: allowanceUsd,
    outputSchema: ROUTER_OUTPUT_SCHEMA,
  });
  budget.record(outcome.costUsd);
  haltIfEnvironmentalBlock("feedback-router", outcome);

  const base = { costUsd: outcome.costUsd, numTurns: outcome.numTurns, decisions: [] };
  if (!outcome.ok) {
    // The router is not retried at all, so a cap failure costs nothing extra
    // here — but the message still has to say WHICH cap, or a human re-runs
    // into the same wall. `artifact: null`: the router's output is consumed in
    // memory, so there is nothing on disk to look at or accept.
    if (outcome.deterministic !== null) {
      return {
        ...base,
        ok: false,
        error: buildDeterministicHaltMessage({
          label: "feedback-router",
          failure: outcome.deterministic,
          costUsd: outcome.costUsd,
          numTurns: outcome.numTurns,
          allowanceUsd,
          perStageCapUsd: MAX_BUDGET_USD_PER_STAGE,
          artifact: null,
          acceptCommand: null,
        }),
      };
    }
    return { ...base, ok: false, error: `the feedback-router call failed: ${outcome.text.slice(0, 300)}` };
  }

  const parsed = parseRouterDecisions(outcome.structuredOutput);
  if (!parsed.ok) {
    return {
      ...base,
      ok: false,
      error: `the feedback-router returned a malformed decision set — ${parsed.error}`,
    };
  }

  const log = await loadRoutingLog();
  let counter = Number(nextRoutingDecisionId(log).slice(3));
  const decisions: FeedbackRouterDecision[] = parsed.decisions.map((decision) => {
    const id = `RD-${counter}`;
    counter += 1;
    return { id, ...decision };
  });

  return { ...base, ok: true, error: null, decisions };
}

/**
 * Forecast cost of re-running the pipeline from `target` through the last
 * implemented stage. Coarse by design — see GO_BACK_DOC_STAGE_ESTIMATE_USD.
 *
 * Known soft spot, stated rather than hidden: spec-implementer's re-run skips
 * modules already recorded complete in the workspace progress log, so its real
 * re-run cost is far lower than one stage cap unless that log is cleared. This
 * orchestrator does not yet invalidate built modules when an upstream design
 * doc changes (docs/lld.md §M28's "mark the stale items" step is not
 * implemented), so the estimate is deliberately the pessimistic one.
 */
function estimateGoBackUsd(target: PipelineStage): number {
  const from = PIPELINE_STAGES.indexOf(target);
  const to = PIPELINE_STAGES.indexOf(LAST_IMPLEMENTED_STAGE);
  let total = 0;
  for (let i = from; i <= to; i += 1) {
    const stage = PIPELINE_STAGES[i];
    if (stage === undefined) continue;
    const io = STAGE_IO[stage];
    if (io === undefined) continue;
    total += io.writes.kind === "document" ? GO_BACK_DOC_STAGE_ESTIMATE_USD : MAX_BUDGET_USD_PER_STAGE;
  }
  return total;
}

/** Which stages a go-back to `target` would re-run, for the console report. */
function stagesRerunBy(target: PipelineStage): PipelineStage[] {
  const from = PIPELINE_STAGES.indexOf(target);
  const to = PIPELINE_STAGES.indexOf(LAST_IMPLEMENTED_STAGE);
  return PIPELINE_STAGES.slice(from, to + 1).filter(isImplemented);
}

interface FeedbackLoopResult {
  state: RunState;
  /** The stage to resume at, or null to stop the run. */
  nextStage: PipelineStage | null;
}

/**
 * The go-back loop. Runs after `originStage` (reviewer) completes successfully.
 *
 * WHAT ENACTING A DECISION ACTUALLY COSTS, stated plainly because it is easy to
 * read "go back to design-planning" as cheap: the pipeline re-runs from the
 * target stage FORWARD THROUGH EVERY DOWNSTREAM STAGE, each at full price. It
 * is not a patch applied to one document. This is the same tradeoff LangGraph's
 * checkpoint time-travel makes — docs/okf.md §6.3: "Everything after that point
 * runs again, including model calls. Replay is a re-run of the tail, not a
 * recording of it." Selective invalidation (rebuild only what is downstream of
 * a changed input, Make/Bazel style) is the alternative that section names, and
 * it is not implemented here. That is a known, chosen limitation, not an
 * oversight — and it is precisely why the gate below is strict.
 *
 * Exactly ONE decision is enacted per drain (docs/lld.md §M28: "one issue
 * enacted per drain"), the one with the earliest target, because re-running
 * from the earliest stage re-runs the later targets anyway. The remaining
 * decisions are logged as `deferred`: the go-back re-runs the reviewer at the
 * end, which produces fresh findings, and the router judges the situation again
 * from what is then true rather than from a stale queue.
 */
async function driveFeedbackLoop(
  state0: RunState,
  budget: RunBudget,
  originStage: PipelineStage,
  maxGoBacksPerRun: number
): Promise<FeedbackLoopResult> {
  let state = state0;

  console.log("");
  console.log("==> feedback-router");
  if (!budget.canAfford(MIN_BUDGET_HEADROOM_USD)) {
    console.log(
      `    skipped — only $${budget.remaining.toFixed(4)} left of $${budget.cap.toFixed(2)}, ` +
        `below the $${MIN_BUDGET_HEADROOM_USD.toFixed(2)} minimum. Re-run to route the feedback.`
    );
    return { state, nextStage: null };
  }

  const router = await invokeFeedbackRouter(budget, originStage);
  console.log(
    `    ${router.ok ? "ok" : "failed"} — ${router.numTurns} turns, $${router.costUsd.toFixed(4)} ` +
      `(cumulative $${budget.spent.toFixed(4)} of $${budget.cap.toFixed(2)})`
  );

  if (!router.ok) {
    // A router that cannot be understood is not a reason to guess. Stop.
    console.log("");
    console.log(`Halting: ${router.error ?? "unknown router failure"}`);
    console.log(`Nothing was routed and no go-back was spent. ${FEEDBACK_LOG_DOC} is unchanged.`);
    return { state, nextStage: null };
  }

  if (router.decisions.length === 0) {
    console.log("");
    console.log("The feedback-router returned no routing decisions — nothing needs re-running.");
    return { state, nextStage: null };
  }

  const used = goBacksUsed(state);
  console.log("");
  console.log(
    `${router.decisions.length} routing decision(s); go-backs used ${used} of ${maxGoBacksPerRun}.`
  );

  // The ordering, the gate and the one-per-drain rule all live in router.ts,
  // which has no SDK import — so they can be exercised against hand-written
  // decision sets without an API key. This function only logs and prints.
  const drain = planDrain(router.decisions, {
    originStage,
    goBacksUsed: used,
    maxGoBacksPerRun,
    remainingUsd: budget.remaining,
    isImplemented,
    estimateUsd: estimateGoBackUsd,
  });

  for (const { decision, verdict, estimateUsd } of drain.items) {
    const entry: RoutingLogEntry = {
      id: decision.id,
      ts: new Date().toISOString(),
      origin_stage: originStage,
      target_stage: decision.target_stage,
      reason: decision.reason,
      priority: decision.priority,
      confidence: decision.confidence,
      confidence_reason: decision.confidence_reason,
      evidence: decision.evidence,
      finding_ids: decision.finding_ids,
      gate: verdict.gate,
      enacted: verdict.enact,
      outcome: verdict.enact ? "enacted" : verdict.escalation === null ? "deferred" : "escalated",
      escalation: verdict.enact ? null : verdict.escalation,
      estimate_usd: estimateUsd,
      remaining_usd: budget.remaining,
      go_backs_used: used,
    };
    await appendRoutingEntry(entry);

    console.log("");
    console.log(
      `  ${decision.id} -> ${decision.target_stage} (${decision.priority} priority, ` +
        `${decision.confidence} confidence) for ${decision.finding_ids.join(", ")}`
    );
    console.log(`    reason:   ${decision.reason}`);
    console.log(`    evidence: ${decision.evidence.join("; ")}`);

    if (verdict.enact) {
      console.log(
        `    ENACTED — re-running ${stagesRerunBy(decision.target_stage).join(" -> ")} ` +
          `(estimated $${estimateUsd.toFixed(2)}, $${budget.remaining.toFixed(4)} left)`
      );
    } else if (verdict.escalation === null) {
      console.log(`    deferred — one decision is enacted per drain; re-judged after the go-back.`);
    } else {
      console.log(`    ESCALATED (${verdict.escalation}) — ${verdict.summary ?? ""}`);
    }
  }

  console.log("");
  console.log(`Routing decisions logged to ${routingLogPath()}.`);

  if (drain.enacted === null) {
    console.log("");
    console.log("No decision cleared the gate, so nothing was re-run and no money was spent on a");
    console.log("go-back. This needs a human: read the escalations above, then either fix the");
    console.log(`finding by hand or re-run the target stage deliberately with a reset ${"state/run.json"}.`);
    return { state, nextStage: null };
  }

  // Rewind BEFORE the re-run so a crash mid-go-back resumes at the target
  // rather than skipping it, and so the target's retry budget is the one for
  // this attempt rather than a leftover from an earlier one.
  state = recordGoBack(rewindTo(state, drain.enacted.target_stage));
  console.log("");
  console.log(
    `Going back to "${drain.enacted.target_stage}" ` +
      `(go-back ${goBacksUsed(state)} of ${maxGoBacksPerRun}).`
  );
  return { state, nextStage: drain.enacted.target_stage };
}

/**
 * Invokes the critic on demand. NOT scheduled, and deliberately not wired into
 * the linear loop or the go-back loop above.
 *
 * That is the user's own framing of this agent ("invoked independently whenever
 * a critical lens is needed") and it is also what the generated plan says:
 * auto-invoking the critic is M33, a "Could" item, i.e. explicitly a later
 * feature. An agent that runs on every pass costs money on every pass whether
 * or not anyone wanted its opinion.
 *
 * `target` is free text — a file path, a stage name, a question. The critic has
 * Read/Grep/Glob and no Write, so IT reports back in its final message and THIS
 * function persists the report, which is what keeps the agent usable from any
 * calling context rather than tied to one fixed pipeline document.
 */
async function invokeCritic(target: string, budget: RunBudget): Promise<boolean> {
  const definition = await loadAgentDefinition("critic");
  await ensureWorkspace();

  const prompt = [
    `You have been invoked on demand to apply a critical lens. You are not running as a pipeline stage.`,
    `What to critique: ${target}`,
    `The pipeline's design documents are in ${DOCS_DIR} and the generated code is at ${workspaceRoot()}. ` +
      `Both are readable; resolve the target above against them. If the target names a pipeline stage ` +
      `rather than a file, critique that stage's output document.`,
    `Judge it from a human perspective — user experience, output quality, and whether it matches what ` +
      `a person actually meant rather than what the spec literally said. Conformance to the spec is ` +
      `already the reviewer's job; do not repeat it.`,
    `Report your critique in your final message. You have no Write tool — the orchestrator records ` +
      `what you say into ${CRITIC_LOG_DOC}.`,
  ].join("\n\n");

  const allowanceUsd = budget.allowanceFor(MAX_BUDGET_USD_PER_STAGE);
  const outcome = await runQueryOnce("critic", definition, "critic", prompt, {
    cwd: PROJECT_ROOT,
    maxBudgetUsd: allowanceUsd,
    additionalDirectories: [workspaceRoot()],
  });
  budget.record(outcome.costUsd);
  haltIfEnvironmentalBlock("critic", outcome);

  if (outcome.deterministic !== null) {
    // The critic is a single on-demand call with no retry loop, so this only
    // has to say which cap stopped it. Its partial report is in outcome.text
    // and is printed rather than being silently dropped.
    console.error(
      buildDeterministicHaltMessage({
        label: "critic",
        failure: outcome.deterministic,
        costUsd: outcome.costUsd,
        numTurns: outcome.numTurns,
        allowanceUsd,
        perStageCapUsd: MAX_BUDGET_USD_PER_STAGE,
        artifact: null,
        acceptCommand: null,
      })
    );
    if (outcome.text.trim().length > 0) {
      console.error("");
      console.error("What the critic had said before it was cut off:");
      console.error(outcome.text.trim());
    }
    return false;
  }

  if (!outcome.ok) {
    console.error(`critic failed: ${outcome.text.slice(0, 500)}`);
    return false;
  }

  const criticLogPath = path.join(PROJECT_ROOT, CRITIC_LOG_DOC);
  let existing: string;
  try {
    existing = await readFile(criticLogPath, "utf-8");
  } catch {
    existing =
      "<!-- Written by: the critic agent, on demand only (`npm run orchestrator -- --critic \"<target>\"`). Read by: humans. -->\n";
  }

  // C-n, monotonic, same scheme as RD-n/F-n (docs/lld.md §base).
  let maxSession = 0;
  for (const match of existing.matchAll(/^##\s+C-(\d+)\b/gm)) {
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > maxSession) maxSession = n;
  }
  const sessionId = `C-${maxSession + 1}`;

  const block = [
    ``,
    `## ${sessionId} ${new Date().toISOString()}`,
    ``,
    `**Target:** ${target}`,
    ``,
    `**Cost:** $${outcome.costUsd.toFixed(4)} over ${outcome.numTurns} turns`,
    ``,
    outcome.text.trim(),
    ``,
  ].join("\n");

  await writeFile(criticLogPath, `${existing.trimEnd()}\n${block}`, "utf-8");

  console.log("");
  console.log(outcome.text.trim());
  console.log("");
  console.log(`Recorded as ${sessionId} in ${CRITIC_LOG_DOC} — $${outcome.costUsd.toFixed(4)}.`);
  return true;
}

/**
 * Repairs typecheck errors that no module owns. ON DEMAND ONLY.
 *
 * Read orchestrator/repair.ts' header first: it has the reason this is an
 * auxiliary agent rather than a pipeline stage, and the reason is evidence
 * about multi-agent pipelines rather than a preference about code layout.
 *
 * `moduleId` is null to repair every outstanding diagnostic, or a module id to
 * repair only the ones in files that module wrote.
 *
 * The sequence, and why it is in this order:
 *
 *   1. refuse without git      — the rollback IS the safety property
 *   2. fresh typecheck         — the ledger records history; tsc records now
 *   3. snapshot commit         — before anything can be edited
 *   4. one query()
 *   5. fresh typecheck + judge — targets gone AND nothing new anywhere
 *   6. accept, or restore the snapshot
 *   7. record the outcome in the ledger, AFTER any restore
 *
 * Step 7 is last for a mechanical reason: the ledger is a tracked file, so a
 * `git reset --hard` would erase a record written before it.
 */
async function invokeRepairer(moduleId: string | null, budget: RunBudget): Promise<boolean> {
  const startedAt = new Date().toISOString();
  await ensureWorkspace();
  const vcs = workspaceVcs();
  const log0 = await loadProgress();
  const repairId = nextRepairId(log0);

  const finish = async (
    partial: Omit<RepairRecord, "repairId" | "startedAt" | "finishedAt" | "targetOwners"> & {
      targetOwners?: string;
    }
  ): Promise<void> => {
    await appendRepair(await loadProgress(), {
      repairId,
      startedAt,
      finishedAt: new Date().toISOString(),
      targetOwners: partial.targetOwners ?? "none",
      ...partial,
    });
    console.log(`Recorded as ${repairId} in the workspace ledger (${PROGRESS_JSON}).`);
  };

  // 1. No git, no repair. This is the only safeguard standing between a bad
  // edit and another module's source, so its absence is a refusal rather than
  // a warning — "repaired without a way back" is not a thing to offer.
  const unavailable = await vcs.check();
  if (unavailable !== null) {
    console.error(`Refusing to run the repairer: ${unavailable}`);
    console.error("");
    console.error(
      "A repair edits files that another module wrote, and is kept only if a fresh typecheck"
    );
    console.error(
      "accepts it. Without git there is no way to undo one that is not accepted, so nothing runs."
    );
    await finish({
      targetModuleId: moduleId,
      targeted: [],
      filesChanged: [],
      outcome: "declined",
      reason: `git unavailable: ${unavailable}`,
      remaining: [],
      regressions: [],
      snapshotCommit: null,
      costUsd: 0,
      numTurns: 0,
    });
    return false;
  }

  // 2. What is broken NOW. Not the ledger's inheritedDiagnostics: those record
  // what was broken during some past module attempt, and may since have been
  // fixed, moved, or joined by errors no attempt ever saw. The ledger's job
  // here is only the part tsc cannot do — whose file each diagnostic is in.
  console.log("Typechecking the workspace to find what is actually broken right now...");
  const before = await typecheckWorkspace();
  const owners = fileOwners(log0.entries);
  const all = selectRepairTargets({ typecheck: before, owners, moduleId: null });
  const selected = selectRepairTargets({ typecheck: before, owners, moduleId });
  const targets = selected.targets;

  for (const line of all.unfixable) {
    console.warn(`  [repair] not attributable to a file, skipped: ${line}`);
  }

  if (targets.length === 0) {
    const scope = moduleId === null ? "the workspace" : `files written by ${moduleId}`;
    if (moduleId !== null && all.targets.length > 0) {
      // A named module with nothing wrong is worth distinguishing from a clean
      // workspace: the caller probably meant a different module id.
      console.log(`Nothing to repair in files written by ${moduleId}.`);
      console.log(
        `Modules that DO have outstanding diagnostics: ${ownersWithDiagnostics(all.targets).join(", ") || "(none)"}.`
      );
    } else {
      console.log(`Nothing to repair: ${scope} has no attributable typecheck diagnostics.`);
    }
    await finish({
      targetModuleId: moduleId,
      targeted: [],
      filesChanged: [],
      outcome: "declined",
      reason: "nothing to repair",
      remaining: [],
      regressions: [],
      snapshotCommit: null,
      costUsd: 0,
      numTurns: 0,
    });
    return true;
  }

  const owned = describeTargetOwners(targets);
  const files = targetFiles(targets);
  console.log("");
  console.log(`${targets.length} diagnostic(s) to repair across ${files.length} file(s) [${owned}]:`);
  for (const target of targets) console.log(`  ${target.parsed.raw}`);
  console.log("");

  // 3. The point of no return, made returnable.
  let snapshot: WorkspaceCommit;
  try {
    snapshot = await vcs.snapshot(`pipeline: pre-repair snapshot for ${repairId}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`Refusing to run the repairer: could not snapshot the workspace: ${detail}`);
    await finish({
      targetModuleId: moduleId,
      targeted: targets.map((t) => t.parsed.raw),
      targetOwners: owned,
      filesChanged: [],
      outcome: "declined",
      reason: `snapshot failed: ${detail}`,
      remaining: [],
      regressions: [],
      snapshotCommit: null,
      costUsd: 0,
      numTurns: 0,
    });
    return false;
  }
  console.log(
    `Workspace snapshotted at ${snapshot.sha.slice(0, 10)}` +
      `${snapshot.isInitialCommit ? " (the repository's first commit — it had no history)" : ""}. ` +
      `A repair that is not accepted resets to it.`
  );

  const rollBack = async (reason: string, verdict: { remaining: string[]; regressions: string[] }, changed: string[], costUsd: number, numTurns: number): Promise<void> => {
    try {
      await vcs.restore(snapshot);
      console.log(`Workspace reset to ${snapshot.sha.slice(0, 10)} — nothing from this repair was kept.`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`ROLLBACK FAILED: ${detail}`);
      console.error(`Reset it yourself: git -C ${vcs.root} reset --hard ${snapshot.sha} && git -C ${vcs.root} clean -fd`);
    }
    await finish({
      targetModuleId: moduleId,
      targeted: targets.map((t) => t.parsed.raw),
      targetOwners: owned,
      filesChanged: changed,
      outcome: "rolled-back",
      reason,
      remaining: verdict.remaining,
      regressions: verdict.regressions,
      snapshotCommit: snapshot.sha,
      costUsd,
      numTurns,
    });
  };

  // 4. One call. There is no retry loop: a repair that failed verification has
  // already been rolled back, so a second attempt would start from the same
  // state with the same prompt and re-roll blind. Re-running it is the human's
  // decision, and it is one command.
  const definition = await loadAgentDefinition("repairer");
  const prompt = buildRepairPrompt({ targets, workspace: vcs.root, moduleId });
  const allowanceUsd = budget.allowanceFor(MAX_BUDGET_USD_PER_REPAIR);
  const snapshotBefore = await snapshotWorkspace();

  const outcome = await runQueryOnce("repairer", definition, "repairer", prompt, {
    cwd: vcs.root,
    maxBudgetUsd: allowanceUsd,
    additionalDirectories: [DOCS_DIR],
  });
  budget.record(outcome.costUsd);
  haltIfEnvironmentalBlock("repairer", outcome);

  const changed = changedFiles(snapshotBefore, await snapshotWorkspace());

  if (outcome.deterministic !== null) {
    console.error(
      buildDeterministicHaltMessage({
        label: "repairer",
        failure: outcome.deterministic,
        costUsd: outcome.costUsd,
        numTurns: outcome.numTurns,
        allowanceUsd,
        perStageCapUsd: MAX_BUDGET_USD_PER_REPAIR,
        artifact: null,
        acceptCommand: null,
      })
    );
    // A capped repair is mid-edit by definition, so it is rolled back without
    // being verified: half a fix is the one outcome nothing downstream can
    // reason about.
    await rollBack(
      `the call hit a deterministic cap (${outcome.deterministic.subtype}) and was rolled back mid-edit`,
      { remaining: targets.map((t) => t.parsed.raw), regressions: [] },
      changed,
      outcome.costUsd,
      outcome.numTurns
    );
    return false;
  }

  if (!outcome.ok) {
    console.error(`repairer failed: ${outcome.text.slice(0, 500)}`);
    await rollBack(
      "the repairer call failed",
      { remaining: targets.map((t) => t.parsed.raw), regressions: [] },
      changed,
      outcome.costUsd,
      outcome.numTurns
    );
    return false;
  }

  if (outcome.text.trim().length > 0) {
    console.log("");
    console.log(outcome.text.trim());
    console.log("");
  }

  // 5. The orchestrator's own check. The agent's report is not evidence.
  console.log("Re-typechecking the workspace to verify the repair...");
  const after = await typecheckWorkspace();
  const verdict = judgeRepair(before, after, targets);

  console.log("");
  console.log(`Fixed:       ${verdict.fixed.length} of ${targets.length} targeted diagnostic(s).`);
  console.log(`Still there: ${verdict.remaining.length}`);
  console.log(`NEW errors:  ${verdict.regressions.length}`);

  if (!verdict.accepted) {
    // 6b. Rejected. The regression count is the important half: a repair that
    // fixes three and introduces two is not a repair, and there is no partial
    // credit because the edits that fixed and the edits that broke cannot be
    // separated from here.
    console.error("");
    console.error("Repair REJECTED.");
    for (const line of verdict.remaining) console.error(`  still broken: ${line}`);
    for (const line of verdict.regressions) console.error(`  NEW:          ${line}`);
    const reason =
      verdict.regressions.length > 0
        ? `introduced ${verdict.regressions.length} new diagnostic(s)` +
          (verdict.remaining.length > 0 ? ` and left ${verdict.remaining.length} unfixed` : "")
        : `left ${verdict.remaining.length} targeted diagnostic(s) unfixed`;
    await rollBack(reason, verdict, changed, outcome.costUsd, outcome.numTurns);
    console.log(`Cost: $${outcome.costUsd.toFixed(4)} over ${outcome.numTurns} turns.`);
    return false;
  }

  // 6a. Accepted: the snapshot commit stays in the history as the "before", and
  // the edits stay in the working tree. They are NOT committed — committing the
  // generated product's code is the product's own business, and the pipeline
  // only commits in order to be able to undo itself.
  console.log("");
  console.log(`Repair ACCEPTED — all ${targets.length} targeted diagnostic(s) fixed, nothing new anywhere.`);
  console.log(`Files changed: ${changed.length > 0 ? changed.join(", ") : "(none)"}`);
  await finish({
    targetModuleId: moduleId,
    targeted: targets.map((t) => t.parsed.raw),
    targetOwners: owned,
    filesChanged: changed,
    outcome: "accepted",
    reason: `all ${targets.length} targeted diagnostic(s) fixed with no new diagnostics anywhere`,
    remaining: [],
    regressions: [],
    snapshotCommit: snapshot.sha,
    costUsd: outcome.costUsd,
    numTurns: outcome.numTurns,
  });
  console.log(`Cost: $${outcome.costUsd.toFixed(4)} over ${outcome.numTurns} turns.`);
  return true;
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
export { LAST_IMPLEMENTED_STAGE, NOT_IMPLEMENTED_REASONS };
export {
  runStage,
  invokeFeedbackRouter,
  invokeCritic,
  invokeRepairer,
  driveFeedbackLoop,
  estimateGoBackUsd,
  nextLinearStage,
};
// Pure decision helpers, exported so they can be exercised without running a
// stage: parseCliArgs owns --force-idea, isSameIdea owns the refusal gate.
export { parseCliArgs, isSameIdea };
export type { CliArgs };
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
  maxGoBacks: number;
  /**
   * `--critic <target>`. When set, the run does ONE critic session against
   * that target and does nothing else — no stage runs, no state is touched.
   */
  critic: string | null;
  /**
   * `--force-idea`. Opt-in permission to replace docs/idea.md with a different
   * idea while earlier stages' artifacts still describe the old one. Off by
   * default and never applied silently: without it that situation is refused.
   */
  forceIdea: boolean;
  /**
   * `--no-install` inverted: whether the orchestrator may run
   * `npm install --ignore-scripts` in the workspace before a module's typecheck.
   *
   * On by default, because without it the typecheck cannot see inside any file
   * that imports a third-party package. Off is a real, supported choice: the
   * package list is written by a model, and someone who does not want
   * model-chosen packages fetched onto their machine must be able to decline
   * without editing code. Declining costs verification coverage, not safety.
   */
  installDeps: boolean;
  /**
   * `--accept-stage <stage>`. The manual escape hatch for a stage that hit a
   * deterministic cap but left a complete artifact behind: record it as
   * successful without re-running it. Like --critic it is a complete
   * alternative to running the pipeline — it spends nothing and starts no stage.
   */
  acceptStage: PipelineStage | null;
  /**
   * `--repair` (every outstanding diagnostic) or `--repair <MODULE_ID>` (just
   * that module's). REPAIR_ALL is the no-argument form; null means the flag was
   * not passed, and those two must stay distinguishable.
   *
   * Like --critic and --accept-stage it is a complete alternative to running
   * the pipeline: no stage runs and no run state is touched.
   */
  repair: string | null;
}

const FLAGS_WITH_VALUES = ["--max-modules", "--max-go-backs", "--critic", ACCEPT_STAGE_FLAG] as const;
const BOOLEAN_FLAGS = ["--force-idea", "--no-install"] as const;

/**
 * `--repair` is in neither list: its value is OPTIONAL, which neither of the
 * two existing shapes allows. `--repair M04` targets one module and bare
 * `--repair` targets everything, so it may consume the next argv entry only
 * when that entry looks like a module id — otherwise `--repair "an app that
 * does X"` would silently swallow the idea text, which is the bug
 * parseCliArgs was written to prevent in the first place.
 */
const REPAIR_MODULE_RE = /^M\d{2,}$/;

/**
 * Splits `--flags` out of the product idea. Before Phase 4 every argument was
 * idea text, so `process.argv.slice(2).join(" ")` was enough; `--max-modules`
 * would have been silently written into docs/idea.md.
 */
function parseCliArgs(argv: string[]): CliArgs {
  const words: string[] = [];
  let maxModules = DEFAULT_MAX_MODULES;
  let maxGoBacks = DEFAULT_MAX_GO_BACKS_PER_RUN;
  let critic: string | null = null;
  let forceIdea = false;
  let installDeps = true;
  let acceptStage: PipelineStage | null = null;
  let repair: string | null = null;

  const knownStage = (value: string | undefined): PipelineStage => {
    const implemented = PIPELINE_STAGES.filter(isImplemented);
    if (value === undefined || !(PIPELINE_STAGES as readonly string[]).includes(value)) {
      throw new Error(
        `${ACCEPT_STAGE_FLAG} needs a pipeline stage name, got "${value ?? ""}". ` +
          `Stages with artifacts to accept: ${implemented.join(", ")}.`
      );
    }
    return value as PipelineStage;
  };

  const positiveInteger = (name: string, value: string | undefined): number => {
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`${name} needs a positive integer, got "${value ?? ""}".`);
    }
    return parsed;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? "";
    if (!arg.startsWith("--")) {
      words.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const name = eq === -1 ? arg : arg.slice(0, eq);
    let value = eq === -1 ? undefined : arg.slice(eq + 1);

    if (name === REPAIR_FLAG) {
      if (value !== undefined) {
        const given = value.trim();
        if (!REPAIR_MODULE_RE.test(given)) {
          throw new Error(
            `${REPAIR_FLAG} takes a module id like M04, got "${given}". ` +
              `Pass ${REPAIR_FLAG} with no value to repair every outstanding diagnostic.`
          );
        }
        repair = given;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && REPAIR_MODULE_RE.test(next.trim())) {
        repair = next.trim();
        i += 1;
      } else {
        repair = REPAIR_ALL;
      }
      continue;
    }

    if ((BOOLEAN_FLAGS as readonly string[]).includes(name)) {
      // A boolean flag takes no value, so it must not swallow the next argv
      // entry — `--force-idea "an app that..."` has to stay idea text.
      if (value !== undefined) {
        throw new Error(`${name} is a switch and takes no value (got "${value}").`);
      }
      if (name === "--no-install") installDeps = false;
      else forceIdea = true;
      continue;
    }

    if (!(FLAGS_WITH_VALUES as readonly string[]).includes(name)) {
      throw new Error(
        `Unrecognised option "${name}". Supported flags are ` +
          `${[...FLAGS_WITH_VALUES, ...BOOLEAN_FLAGS, REPAIR_FLAG].join(", ")}.`
      );
    }
    if (value === undefined) {
      value = argv[i + 1];
      i += 1;
    }

    if (name === "--max-modules") maxModules = positiveInteger(name, value);
    else if (name === "--max-go-backs") maxGoBacks = positiveInteger(name, value);
    else if (name === ACCEPT_STAGE_FLAG) acceptStage = knownStage(value?.trim());
    else {
      // --max-go-backs 0 is a positive-integer error above; --critic "" is not,
      // so it is rejected here rather than reaching the agent as an empty task.
      if (value === undefined || value.trim().length === 0) {
        throw new Error(`--critic needs something to critique, e.g. --critic docs/design.md`);
      }
      critic = value.trim();
    }
  }

  const idea = words.join(" ").trim();

  // `--repair` is a complete alternative to running the pipeline, so idea text
  // alongside it is never acted on. Silently ignoring it is the dangerous
  // reading: bare `--repair` takes no value, so
  // `--repair "an app that does X"` parses as "repair everything, and here is
  // some text nobody will look at" — someone who meant to start a build would
  // instead spend money editing an existing workspace's code. Refused rather
  // than guessed at; nothing has run at this point.
  if (repair !== null && idea.length > 0) {
    throw new Error(
      `${REPAIR_FLAG} does not take an idea, and cannot be combined with one (got "${truncateForMessage(idea)}"). ` +
        `Use "${REPAIR_FLAG}" alone to repair every outstanding diagnostic, or "${REPAIR_FLAG} M04" ` +
        `to repair one module's — and run the pipeline as a separate command.`
    );
  }

  return {
    idea: idea.length > 0 ? idea : null,
    maxModules,
    maxGoBacks,
    critic,
    forceIdea,
    installDeps,
    acceptStage,
    repair,
  };
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

/**
 * Whether two idea texts are the same idea.
 *
 * The comparison stays the one that was already good enough to detect this
 * case — equality of the idea-doc body — widened only for whitespace and line
 * wrapping, which are formatting, not meaning. Nothing looser: this gate now
 * stops a run, and a real change slipping past it is the expensive direction.
 */
function isSameIdea(a: string, b: string): boolean {
  const normalise = (text: string): string => text.replace(/\s+/g, " ").trim();
  return normalise(a) === normalise(b);
}

/** One-line form of an idea for a console message. */
function truncateForMessage(idea: string): string {
  const flat = idea.replace(/\s+/g, " ").trim();
  return flat.length > 120 ? `${flat.slice(0, 117)}...` : flat;
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
  if (state.stage === LAST_IMPLEMENTED_STAGE) {
    console.log(
      `The feedback loop already ran for this run (${goBacksUsed(state)} go-back(s) used). ` +
        `Every routing decision, enacted or not, is in ${routingLogPath()}.`
    );
    console.log(
      "Re-running does NOT re-drive the router: that would be a billable call nobody asked for. " +
        "Act on the escalations there, or reset the run state below."
    );
    console.log("");
  }
  if (nextStage === null) {
    console.log("There is no further stage in PIPELINE_STAGES.");
  } else {
    console.log(
      NOT_IMPLEMENTED_REASONS[nextStage] ??
        `The next stage ("${nextStage}") is not implemented until Phase ${phaseForStage(nextStage)}+.`
    );
  }
  console.log("");
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

/** What the history entry says about a stage a human accepted by hand. */
const ACCEPTED_NOTE =
  `accepted by a human with ${ACCEPT_STAGE_FLAG} — the stage's own call did not report success`;

/**
 * `--accept-stage <stage>`: record a stage as successful because its artifact
 * is on disk and a human has read it, without paying to run the stage again.
 *
 * This is the other half of the deterministic-failure fix. Knowing that
 * docs/hld.md was complete is worth nothing if the only way to act on it is to
 * re-run the stage that produced it. It is deliberately a small manual escape
 * hatch rather than an auto-promotion: a document written by a call that hit
 * its budget cap MIGHT be truncated mid-thought, and that judgement needs eyes,
 * not a byte count.
 *
 * Three guards, all refusals rather than warnings:
 *   1. the stage must be one this build can actually run (it needs a STAGE_IO
 *      entry, or there is no artifact to check);
 *   2. it must be the stage the run would run NEXT — accepting anything else
 *      would silently skip the stages in between;
 *   3. the artifact must pass the same verification the success path applies.
 *
 * Nothing is spent and no agent runs; like --critic this is a complete
 * alternative to running the pipeline.
 */
async function acceptStageArtifact(stage: PipelineStage, state0: RunState): Promise<boolean> {
  const io = STAGE_IO[stage];
  if (io === undefined) {
    console.error(
      `Refusing to accept "${stage}": it is not implemented in Phase ${phaseForStage(stage)}, so ` +
        `it has no artifact this orchestrator knows how to check.`
    );
    console.error(`Acceptable stages: ${PIPELINE_STAGES.filter(isImplemented).join(", ")}.`);
    return false;
  }

  const expected = nextLinearStage(state0.stage);
  if (expected !== stage) {
    console.error(
      `Refusing to accept "${stage}": the run's next stage is ` +
        `${expected === null ? "none — the pipeline is finished" : `"${expected}"`}, and the last ` +
        `stage that completed successfully was ` +
        `${state0.stage === null ? "none" : `"${state0.stage}"`}.`
    );
    console.error("");
    console.error(
      `${ACCEPT_STAGE_FLAG} only accepts the stage the run is actually stuck on. Accepting a ` +
        `later stage would mark the ones in between as done without them ever running.`
    );
    return false;
  }

  const artifact = await inspectStageArtifact(io);
  if (!artifact.complete) {
    console.error(`Refusing to accept "${stage}": its output is missing or not real content.`);
    console.error("");
    console.error(`  ${artifact.description}`);
    console.error(`  ${artifact.detail}`);
    console.error("");
    console.error(
      `There is nothing here to vouch for, so the stage does have to run. Nothing was changed.`
    );
    return false;
  }

  // beginStage + finishStage rather than a hand-written entry, so the history
  // this writes has the same shape every other entry has — plus a note, because
  // "succeeded" and "a human said this was good enough" are different facts and
  // the run record should not confuse them later.
  const closed = finishStage(beginStage(state0, stage), stage, "success");
  const history = [...closed.history];
  const last = history[history.length - 1];
  if (last !== undefined) history[history.length - 1] = { ...last, note: ACCEPTED_NOTE };
  const retries: RetryCounts = { ...closed.retries };
  delete retries[stage];
  await saveState({ ...closed, history, retries });

  const next = nextLinearStage(stage);
  console.log(`Accepted "${stage}" without re-running it.`);
  console.log("");
  console.log(`  artifact: ${artifact.description}`);
  console.log(`            ${artifact.detail}`);
  console.log(`  recorded: state/run.json now says "${stage}" finished successfully; its retry`);
  console.log(`            counter was cleared. No agent ran and nothing was spent.`);
  console.log("");
  console.log(`YOU are vouching for that artifact. The only automatic check applied is the`);
  console.log(`one a successful run applies: the output exists and is not a placeholder.`);
  console.log(`Nothing has verified that it is finished rather than truncated mid-thought,`);
  console.log(`and every later stage builds on whatever is in there.`);
  console.log("");
  if (next === null || STAGE_IO[next] === undefined) {
    console.log(`There is no further implemented stage to run.`);
  } else {
    console.log(`Continue the run from "${next}":`);
    console.log("");
    console.log("  npm run orchestrator");
  }
  return true;
}

async function main(): Promise<void> {
  await loadDotEnv();

  const cli = parseCliArgs(process.argv.slice(2));

  // --critic is a complete alternative to running the pipeline, handled before
  // state is loaded or docs/idea.md is touched. The critic is ON DEMAND: it
  // never runs as part of a pipeline invocation, so asking for one must not
  // also advance, resume or complete a run as a side effect.
  if (cli.critic !== null) {
    reportAuthSource();
    console.log(`Critic (on demand) — target: ${cli.critic}`);
    console.log("No pipeline stage will run and no run state will be changed.");
    const budget = new RunBudget(MAX_BUDGET_USD_PER_RUN);
    const ok = await invokeCritic(cli.critic, budget);
    console.log(`Total cost: $${budget.spent.toFixed(4)}`);
    if (!ok) process.exitCode = 1;
    return;
  }

  // --repair is a complete alternative to running the pipeline, handled here for
  // the same reason --critic is: the repairer is ON DEMAND, so asking for one
  // must not advance, resume or complete a run as a side effect. It reads the
  // workspace and the workspace ledger and never touches state/run.json.
  if (cli.repair !== null) {
    const moduleId = cli.repair === REPAIR_ALL ? null : cli.repair;
    reportAuthSource();
    console.log(
      `Repairer (on demand) — target: ${moduleId ?? "every outstanding inherited diagnostic"}`
    );
    console.log("No pipeline stage will run and no run state will be changed.");
    const budget = new RunBudget(MAX_BUDGET_USD_PER_RUN);
    const ok = await invokeRepairer(moduleId, budget);
    console.log(`Total cost: $${budget.spent.toFixed(4)}`);
    if (!ok) process.exitCode = 1;
    return;
  }

  const state0 = await loadState();

  // --accept-stage is also a complete alternative to running the pipeline, and
  // is handled before docs/idea.md is touched: it is the move a human makes
  // when a stage hit a deterministic cap but left a good artifact, and it must
  // not start, resume or bill anything as a side effect of being asked for.
  if (cli.acceptStage !== null) {
    const accepted = await acceptStageArtifact(cli.acceptStage, state0);
    if (!accepted) process.exitCode = 1;
    return;
  }

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
  // not: the already-completed stages ran against the old one. This used to be
  // a warning the run then ignored, which cost a real user $1.99 building the
  // PREVIOUS product's modules under the new idea's name. It is a refusal now,
  // taken before anything is spent or written.
  if (state0.stage !== null) {
    const previousIdea = await readIdeaDocBody();
    if (previousIdea !== null && !isSameIdea(previousIdea, idea)) {
      if (!cli.forceIdea) {
        console.error(
          `Refusing to run: ${IDEA_DOC} is being replaced with a DIFFERENT idea, but stages up ` +
            `to "${state0.stage}" already ran against the previous one.`
        );
        console.error("");
        console.error(`  on disk now: ${truncateForMessage(previousIdea)}`);
        console.error(`  you passed:  ${truncateForMessage(idea)}`);
        console.error("");
        console.error(
          `Continuing would build the new idea's name onto the old idea's design: every ` +
            `document in docs/ and every module already in the code workspace describes the ` +
            `idea on disk. Nothing has been spent, and ${IDEA_DOC} has NOT been changed.`
        );
        console.error("");
        console.error("To start the new idea cleanly:");
        console.error("");
        console.error("  rm state/run.json");
        console.error("  ./setup.sh");
        console.error(`  PIPELINE_WORKSPACE=~/agent-pipeline-workspace-<new> \\`);
        console.error(`    npm run orchestrator -- "${truncateForMessage(idea)}"`);
        console.error("");
        console.error(
          "setup.sh does NOT clear docs/ — blank those files back to their header comment " +
            "first, or the new run reads the old product's documents. A separate " +
            "PIPELINE_WORKSPACE keeps the old product's code and its progress ledger intact."
        );
        console.error("");
        console.error(
          `To continue against the existing run state anyway — knowing the earlier stages ran ` +
            `on the other idea — re-run with --force-idea.`
        );
        process.exitCode = 1;
        return;
      }
      console.warn(
        `--force-idea: ${IDEA_DOC} is being replaced with a different idea even though stages ` +
          `up to "${state0.stage}" already ran against the previous one. Proceeding because you ` +
          `asked; the artifacts in docs/ still describe the old idea.`
      );
      console.warn("");
    }
  }
  await writeIdeaDoc(idea);

  console.log(`Idea: ${idea}`);
  reportAuthSource();
  console.log(
    `Phase ${CURRENT_PHASE} runs through "${LAST_IMPLEMENTED_STAGE}", then routes feedback; ` +
      `"testing-agent" is still blocked on M18.`
  );
  console.log(
    `MAX_RETRIES_PER_STAGE = ${MAX_RETRIES_PER_STAGE} (stage-level failures); ` +
      `MAX_ATTEMPTS_PER_MODULE = ${MAX_ATTEMPTS_PER_MODULE} (spec-implementer, per module)`
  );
  console.log(
    `Run budget: $${MAX_BUDGET_USD_PER_RUN.toFixed(2)} cumulative, ` +
      `$${MAX_BUDGET_USD_PER_STAGE.toFixed(2)} per call; --max-modules ${cli.maxModules}; ` +
      `--max-go-backs ${cli.maxGoBacks} (used ${goBacksUsed(state0)} so far)`
  );
  console.log(
    cli.installDeps
      ? "Workspace dependencies: the orchestrator will run `npm install --ignore-scripts` in the " +
          "workspace when package.json's dependency set changes, so the typecheck can resolve " +
          "imports. Lifecycle scripts are disabled, so no installed package's code ever runs. " +
          "Pass --no-install to skip it (unresolved imports then stay warnings)."
      : "Workspace dependencies: --no-install given — nothing will be installed, and unresolved " +
          "third-party imports stay warnings, so the typecheck cannot see inside files that " +
          "import them."
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

    const result = await runStage(stage, budget, cli.maxModules, cli.installDeps);

    if (result.outcome === "success") {
      state = finishStage(state, stage, "success");
      await saveState(state);
      console.log(
        `    ok — ${result.numTurns} turns, $${result.costUsd.toFixed(4)} ` +
          `(cumulative $${budget.spent.toFixed(4)} of $${budget.cap.toFixed(2)})`
      );

      // Reaching the last linear stage is no longer the end of the run — it is
      // the point at which the loop closes. feedback-router may send execution
      // back to an earlier stage, and the `while` then re-runs FORWARD from
      // there through every downstream stage. That re-run is at full cost; see
      // driveFeedbackLoop's header for why that is a chosen tradeoff.
      if (stage === LAST_IMPLEMENTED_STAGE) {
        const loop = await driveFeedbackLoop(state, budget, stage, cli.maxGoBacks);
        state = loop.state;
        await saveState(state);
        if (loop.nextStage !== null) {
          stage = loop.nextStage;
          continue;
        }
        console.log("");
        console.log(`Stopping after "${LAST_IMPLEMENTED_STAGE}" — end of Phase ${CURRENT_PHASE}.`);
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
      if (result.budgetHalt) {
        // With --max-modules defaulting to 54, THIS is the message that ends a
        // normal long run, so it has to answer both questions a human has at
        // that moment: how much did that cost, and what do I type next.
        console.log(
          `Halted on the cumulative run budget: spent $${budget.spent.toFixed(4)} of the ` +
            `$${budget.cap.toFixed(2)} allowed per run.`
        );
        console.log(
          `Nothing was lost. Every module that completed is recorded in ` +
            `${workspaceRoot()}/PROGRESS.md and will be skipped, not rebuilt.`
        );
        console.log("");
        console.log(`To continue where this stopped, run the same command again:`);
        console.log("");
        console.log(`  npm run orchestrator`);
        console.log("");
        console.log(
          `Each invocation gets a fresh $${budget.cap.toFixed(2)} budget, so a long plan finishes ` +
            `over several runs. Raising MAX_BUDGET_USD_PER_RUN in orchestrator/budget.ts would mean ` +
            `fewer, larger runs — that is a spending decision and is deliberately left to you.`
        );
      } else {
        console.log(`Re-run to continue "${stage}" — completed work is skipped, not redone.`);
      }
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
