// Shared types for the pipeline orchestrator. Phase 0: wiring only.

/**
 * The linear pipeline stages, in the order they normally run.
 * feedback-router is not itself a "position" in the linear order — it's the
 * mechanism that redirects execution back to an earlier PipelineStage.
 * critic is deliberately excluded: it's an on-demand agent, not a stage.
 */
export const PIPELINE_STAGES = [
  "product-understanding",
  "product-alignment",
  "deep-discovery",
  "design-planning",
  "architecture-planning",
  "implementation-planning",
  "system-design",
  "low-level-design",
  "spec-implementer",
  "reviewer",
  "testing-agent",
] as const;

export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** Agents that exist but are not part of the linear PIPELINE_STAGES order. */
export type AuxiliaryAgent = "feedback-router" | "critic";

export type AgentName = PipelineStage | AuxiliaryAgent;

/** A single entry in the run's history log. */
export interface HistoryEntry {
  stage: PipelineStage | AuxiliaryAgent;
  startedAt: string;
  finishedAt: string | null;
  outcome: "success" | "failure" | "in-progress" | null;
}

/** Per-stage retry counters, keyed by stage name. */
export type RetryCounts = Partial<Record<PipelineStage, number>>;

/** The full persisted state of a pipeline run (state/run.json). */
export interface RunState {
  stage: PipelineStage | null;
  history: HistoryEntry[];
  retries: RetryCounts;
}

/**
 * Structured output of the feedback-router agent. Consumed programmatically
 * by orchestrator/run.ts to decide which stage to re-invoke.
 */
export interface FeedbackRouterDecision {
  target_stage: PipelineStage;
  reason: string;
  priority: "low" | "medium" | "high";
}
