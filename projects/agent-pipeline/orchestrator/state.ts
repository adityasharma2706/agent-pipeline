// Read/write helpers for state/run.json. Phase 0: wiring only, no agent
// execution logic lives here.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HistoryEntry, PipelineStage, RunState } from "./types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE_PATH = path.join(__dirname, "..", "state", "run.json");

/** Max times a single stage may be retried before the orchestrator must stop. */
export const MAX_RETRIES_PER_STAGE = 3;

function isRunState(value: unknown): value is RunState {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    ("stage" in candidate) &&
    Array.isArray(candidate.history) &&
    typeof candidate.retries === "object" &&
    candidate.retries !== null
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
      `state/run.json does not match the expected RunState shape ` +
        `(needs "stage", "history": [], "retries": {}) at ${STATE_FILE_PATH}. ` +
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
 * Advances the run's current stage and appends a history entry.
 * Does not invoke any agent — purely a state transition helper.
 */
export function advanceStage(state: RunState, nextStage: PipelineStage): RunState {
  const entry: HistoryEntry = {
    stage: nextStage,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    outcome: "in-progress",
  };
  return {
    ...state,
    stage: nextStage,
    history: [...state.history, entry],
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
