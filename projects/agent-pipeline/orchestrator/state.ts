// Read/write helpers for state/run.json. No agent execution logic lives here:
// these are pure state transitions plus load/save.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PIPELINE_STAGES } from "./types.js";
import type {
  HistoryEntry,
  PipelineStage,
  RetryCounts,
  RunState,
  StageOutcome,
} from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE_PATH = path.join(__dirname, "..", "state", "run.json");

/** Max times a single stage may be retried before the orchestrator must stop. */
export const MAX_RETRIES_PER_STAGE = 3;

/**
 * History entries may name an auxiliary agent (feedback-router/critic) as well
 * as a linear stage, so `stage` is only checked for being a string. `outcome`
 * is checked exactly, because the control loop and (later) the feedback-router
 * branch on it.
 */
function isHistoryEntry(value: unknown): value is HistoryEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  const outcomeOk =
    entry.outcome === null ||
    entry.outcome === "success" ||
    entry.outcome === "failure" ||
    entry.outcome === "partial" ||
    entry.outcome === "in-progress";
  return (
    typeof entry.stage === "string" &&
    typeof entry.startedAt === "string" &&
    (entry.finishedAt === null || typeof entry.finishedAt === "string") &&
    outcomeOk
  );
}

/**
 * Validates the persisted shape properly rather than loosely: an unrecognised
 * `stage` string used to survive validation and then silently restart the run
 * from the first stage (PIPELINE_STAGES.indexOf(garbage) === -1, so
 * nextLinearStage returned index 0), which looks like a working resume but
 * isn't one.
 */
function isRunState(value: unknown): value is RunState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;

  if (!("stage" in candidate)) return false;
  if (
    candidate.stage !== null &&
    !(
      typeof candidate.stage === "string" &&
      (PIPELINE_STAGES as readonly string[]).includes(candidate.stage)
    )
  ) {
    return false;
  }

  if (!Array.isArray(candidate.history) || !candidate.history.every(isHistoryEntry)) return false;

  const retries = candidate.retries;
  if (typeof retries !== "object" || retries === null || Array.isArray(retries)) return false;
  if (
    !Object.values(retries as Record<string, unknown>).every(
      (count) => typeof count === "number" && Number.isInteger(count) && count >= 0
    )
  ) {
    return false;
  }

  // Absent is valid: every state file written before Phase 5 predates the
  // field, and rejecting those would strand runs that are mid-pipeline right
  // now. Present-but-nonsense is NOT valid — a corrupt go-back counter is the
  // one thing standing between a bad router and an unbounded re-run loop.
  const goBacks = candidate.goBacksUsed;
  return (
    goBacks === undefined ||
    (typeof goBacks === "number" && Number.isInteger(goBacks) && goBacks >= 0)
  );
}

/**
 * Loads state/run.json from disk. Throws a clear, actionable error if the
 * file is missing or malformed rather than letting a raw ENOENT/SyntaxError
 * propagate — the caller (or a human) needs to know what to do next.
 */
export async function loadState(): Promise<RunState> {
  let raw: string;
  try {
    raw = await readFile(STATE_FILE_PATH, "utf-8");
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ENOENT") {
      throw new Error(
        `state/run.json does not exist at ${STATE_FILE_PATH}. Run ./setup.sh to create it.`
      );
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `state/run.json is not valid JSON (${STATE_FILE_PATH}). Fix or delete it and re-run ./setup.sh to regenerate.`
    );
  }

  if (!isRunState(parsed)) {
    throw new Error(
      `state/run.json does not match the expected RunState shape at ${STATE_FILE_PATH} ` +
        `(needs "stage": null or a known pipeline stage name, "history": an array of ` +
        `{stage, startedAt, finishedAt, outcome} entries, "retries": an object of ` +
        `stage -> non-negative integer). ` +
        `Fix or delete it and re-run ./setup.sh to regenerate.`
    );
  }
  return parsed;
}

/** Persists the given state back to state/run.json. */
export async function saveState(state: RunState): Promise<void> {
  await writeFile(STATE_FILE_PATH, JSON.stringify(state, null, 2) + "\n", "utf-8");
}

/**
 * `state.stage` means "the last stage that COMPLETED SUCCESSFULLY" — the
 * control loop resumes at nextLinearStage(state.stage). Only finishStage with
 * outcome "success" may move it.
 *
 * Opens a history entry for an attempt about to start. Persisting this before
 * the agent runs is deliberate: if the process is killed mid-stage, the entry
 * stays "in-progress", which is the honest record of what happened.
 * Does not invoke any agent — purely a state transition helper.
 */
export function beginStage(state: RunState, stage: PipelineStage): RunState {
  const entry: HistoryEntry = {
    stage,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: "in-progress",
  };
  return {
    ...state,
    history: [...state.history, entry],
  };
}

/**
 * Closes the open ("in-progress") history entry for `stage` with a real
 * `finishedAt` and a terminal outcome, and — on success only — advances
 * `state.stage`. A failed attempt stays in history as a failure rather than
 * disappearing, so the run's record shows what was actually tried.
 *
 * Closes the MOST RECENT open entry for the stage; an entry abandoned by an
 * earlier crashed run stays "in-progress", because that is what happened to it.
 *
 * If there is no open entry (e.g. a stage recorded by a future caller that
 * never called beginStage), an already-closed entry is appended instead of
 * throwing: losing the record would be worse than an approximate startedAt.
 */
export function finishStage(
  state: RunState,
  stage: PipelineStage,
  outcome: StageOutcome
): RunState {
  const now = new Date().toISOString();
  const history = [...state.history];

  let openIndex = -1;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (entry !== undefined && entry.stage === stage && entry.outcome === "in-progress") {
      openIndex = i;
      break;
    }
  }

  const open = openIndex === -1 ? undefined : history[openIndex];
  if (open === undefined) {
    history.push({ stage, startedAt: now, finishedAt: now, outcome });
  } else {
    history[openIndex] = { ...open, finishedAt: now, outcome };
  }

  return {
    ...state,
    stage: outcome === "success" ? stage : state.stage,
    history,
  };
}

/**
 * Records a retry attempt for a stage, enforcing MAX_RETRIES_PER_STAGE.
 * Throws once the cap would be exceeded, so the orchestrator's control loop
 * cannot silently spin forever on a broken stage.
 */
export function recordRetry(state: RunState, stage: PipelineStage): RunState {
  const currentCount = state.retries[stage] ?? 0;
  const nextCount = currentCount + 1;
  if (nextCount > MAX_RETRIES_PER_STAGE) {
    throw new Error(
      `Stage "${stage}" exceeded MAX_RETRIES_PER_STAGE (${MAX_RETRIES_PER_STAGE}). ` +
        `Halting to avoid an infinite loop; this needs human or sattva-level intervention.`
    );
  }
  return {
    ...state,
    retries: {
      ...state.retries,
      [stage]: nextCount,
    },
  };
}

/** Reads the go-back counter, treating a pre-Phase-5 state file as zero. */
export function goBacksUsed(state: RunState): number {
  return state.goBacksUsed ?? 0;
}

/**
 * Records that a go-back was enacted. The cap itself lives with the router
 * gate (orchestrator/router.ts) rather than here, because exceeding it is an
 * escalation with options for a human, not a thrown halt like recordRetry's.
 */
export function recordGoBack(state: RunState): RunState {
  return { ...state, goBacksUsed: goBacksUsed(state) + 1 };
}

/**
 * Clears the retry counters for `stage` and everything after it in the linear
 * order, and rewinds `state.stage` to just before `stage`.
 *
 * Both halves matter for a go-back. Rewinding `state.stage` is what makes the
 * re-run resumable: it means "the last stage that completed successfully" is
 * once again the one before the target, so a crashed go-back resumes at the
 * target rather than skipping it. Clearing the retries is what stops a stage
 * that failed twice earlier in the run from getting only one attempt on its
 * re-run — the loop guard for go-backs is maxGoBacksPerRun, not a retry
 * counter carried over from a different attempt at a different input.
 */
export function rewindTo(state: RunState, stage: PipelineStage): RunState {
  const targetIndex = PIPELINE_STAGES.indexOf(stage);
  if (targetIndex === -1) {
    throw new Error(`rewindTo() was given "${stage}", which is not a pipeline stage.`);
  }

  const retries: RetryCounts = {};
  for (const [name, count] of Object.entries(state.retries)) {
    const index = PIPELINE_STAGES.indexOf(name as PipelineStage);
    if (index !== -1 && index < targetIndex && count !== undefined) {
      retries[name as PipelineStage] = count;
    }
  }

  const previous = targetIndex === 0 ? null : (PIPELINE_STAGES[targetIndex - 1] ?? null);
  return { ...state, stage: previous, retries };
}
