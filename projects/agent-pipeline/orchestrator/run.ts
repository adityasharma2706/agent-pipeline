// orchestrator/run.ts
//
// Phase 0 scaffold: stage wiring only. Nothing in this file actually calls
// the Claude Agent SDK yet. Phase 1 fills in real invocation logic for the
// product-understanding -> product-alignment -> deep-discovery vertical
// slice; later phases extend it to the rest of PIPELINE_STAGES plus
// feedback-router and critic.

import { loadState, saveState, advanceStage, recordRetry, MAX_RETRIES_PER_STAGE } from "./state.js";
import { PIPELINE_STAGES } from "./types.js";
import type { PipelineStage, FeedbackRouterDecision, RunState } from "./types.js";

/**
 * Given a stage name, this should:
 *   1. Read agents/<stageName>.md and parse its YAML frontmatter + system prompt.
 *   2. Construct the appropriate context (which docs/*.md this stage reads).
 *   3. Call the Claude Agent SDK (@anthropic-ai/claude-agent-sdk) to actually
 *      run the agent, streaming/collecting its output.
 *   4. Have the agent write its designated docs/*.md output file.
 *   5. Return success/failure so the caller can advance state or recordRetry.
 *
 * TODO(Phase 1): implement steps 1-5 above for product-understanding,
 * product-alignment, and deep-discovery only. Leave the rest stubbed until
 * their respective phases.
 */
function runStage(stageName: PipelineStage): never {
  throw new Error(`runStage("${stageName}") is not implemented yet — Phase 0 wiring only.`);
}

/**
 * Should read docs/feedback_log.md, invoke the feedback-router agent via the
 * SDK, and parse its output into a FeedbackRouterDecision[] that the control
 * loop can act on (i.e. call advanceStage with decision.target_stage).
 *
 * TODO(Phase 2+, once reviewer/testing-agent produce real feedback):
 * implement the SDK call and the output parsing/validation against the
 * FeedbackRouterDecision shape.
 */
function invokeFeedbackRouter(): never {
  throw new Error("invokeFeedbackRouter() is not implemented yet — Phase 0 wiring only.");
}

/**
 * Should invoke the critic agent on demand (not on a fixed schedule) with
 * whatever artifact needs a critical/human-perspective lens.
 *
 * TODO(later phase): implement the SDK call. Callers pass the artifact/context
 * to critique; critic reports back directly rather than writing a fixed doc.
 */
function invokeCritic(_targetDescription: string): never {
  throw new Error("invokeCritic() is not implemented yet — Phase 0 wiring only.");
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

async function main(): Promise<void> {
  console.log("Phase 0 scaffold — stage wiring only, no agent execution yet");
  console.log(`Pipeline stages (${PIPELINE_STAGES.length}): ${PIPELINE_STAGES.join(" -> ")}`);
  console.log(`MAX_RETRIES_PER_STAGE = ${MAX_RETRIES_PER_STAGE}`);

  const state = await loadState();
  console.log("Loaded state/run.json:");
  console.log(JSON.stringify(state, null, 2));

  // Nothing below actually mutates persisted state in Phase 0 — this just
  // demonstrates that advanceStage/recordRetry/saveState are wired and
  // importable for Phase 1 to use for real.
  void advanceStage;
  void recordRetry;
  void saveState;

  // TODO(Phase 1): once runStage() is real, replace the log-only main() above
  // with an actual control loop, e.g.:
  //   let state = await loadState();
  //   let stage = nextLinearStage(state.stage);
  //   while (stage !== null) {
  //     try {
  //       await runStage(stage); // real SDK call
  //       state = advanceStage(state, stage);
  //       await saveState(state);
  //       if (stage === "reviewer") break; // human checkpoint, per reviewer.md
  //       stage = nextLinearStage(stage);
  //     } catch (err) {
  //       state = recordRetry(state, stage); // throws past MAX_RETRIES_PER_STAGE
  //       await saveState(state);
  //     }
  //   }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
