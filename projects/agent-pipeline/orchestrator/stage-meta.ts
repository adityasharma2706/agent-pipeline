// Stage facts that are needed by BOTH the orchestrator control loop and by
// read-only consumers (the local UI server), extracted from run.ts so there is
// exactly one copy of them.
//
// Why extracted rather than imported from run.ts: run.ts imports the Claude
// Agent SDK, and a read-only status endpoint has no business loading an agent
// runtime just to find out why a stage is unimplemented. Nothing in this file
// imports the SDK, so it is cheap and safe to import from anywhere.

import type { PipelineStage } from "./types.js";

/**
 * The last stage in the linear order that this build can run. Reaching it
 * successfully is what triggers the feedback loop, not the end of the run.
 */
export const LAST_IMPLEMENTED_STAGE: PipelineStage = "reviewer";

/**
 * Why a stage is not implemented, where "not implemented yet" is not the real
 * answer. Read by stageIo() so the error a human sees says what is actually
 * blocking rather than just naming a phase number, and by the UI dashboard for
 * the same reason.
 */
export const NOT_IMPLEMENTED_REASONS: Partial<Record<PipelineStage, string>> = {
  "testing-agent":
    'Stage "testing-agent" is blocked on module M18 (the sandbox executor), not merely unscheduled. ' +
    "It runs end-to-end tests via Playwright, which needs a shell. Decision LD-1 in docs/lld.md " +
    "(line ~396) requires ALL command execution to go through a custom `sandbox_exec` MCP tool " +
    "created with createSdkMcpServer, and to NEVER enable native Bash. M18 is that tool and has " +
    "not been built. Giving testing-agent Bash instead would violate the pipeline's own generated " +
    "design, so it stays unimplemented until M18 ships.",
};
