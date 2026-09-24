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

/**
 * Terminal outcome of one stage attempt.
 *
 * "partial" arrived with Phase 4. spec-implementer runs a bounded number of
 * modules per invocation (`--max-modules`), so an attempt can end having done
 * real, correct, recorded work without the stage being finished. Calling that
 * "success" would advance `state.stage` past a stage with 34 modules left;
 * calling it "failure" would burn a retry for something that did not fail.
 */
export type StageOutcome = "success" | "failure" | "partial";

/** A single entry in the run's history log. */
export interface HistoryEntry {
  stage: PipelineStage | AuxiliaryAgent;
  startedAt: string;
  finishedAt: string | null;
  outcome: StageOutcome | "in-progress" | null;
}

/** Per-stage retry counters, keyed by stage name. */
export type RetryCounts = Partial<Record<PipelineStage, number>>;

/**
 * The full persisted state of a pipeline run (state/run.json).
 *
 * `goBacksUsed` arrived with Phase 5 and is the counter behind
 * `router.maxGoBacksPerRun` (docs/lld.md §M01 defaults, value 3). It is
 * OPTIONAL on the persisted shape purely for backwards compatibility: every
 * state file written before Phase 5 lacks the field, and refusing to load
 * those would strand real runs. Readers must treat `undefined` as 0.
 */
export interface RunState {
  stage: PipelineStage | null;
  history: HistoryEntry[];
  retries: RetryCounts;
  goBacksUsed?: number;
}

/** Severity/priority ladder shared by findings and routing decisions. */
export type Priority = "low" | "medium" | "high";

/**
 * How sure the feedback-router is that `target_stage` is the stage actually
 * responsible for the finding. This is the field the go-back gate turns on —
 * see ROUTER_AUTO_PROCEED_MIN_CONFIDENCE in orchestrator/router.ts for why
 * only "high" is allowed to act on its own.
 */
export type RouterConfidence = "low" | "medium" | "high";

/**
 * Structured output of the feedback-router agent, one entry per feedback item.
 * Consumed programmatically by orchestrator/run.ts to decide which stage to
 * re-invoke.
 *
 * The agent-supplied fields keep snake_case because they are the literal keys
 * of the JSON schema handed to the SDK via `options.outputFormat`; `id` is the
 * one field the ORCHESTRATOR fills in, allocating `RD-n` monotonically per
 * docs/lld.md §base ("Counters for RD-n (routing decisions), I-n (issues),
 * S-n (signals) ... are monotonic per project").
 */
export interface FeedbackRouterDecision {
  /** `RD-n`. Allocated by the orchestrator, never by the agent. */
  id: string;
  target_stage: PipelineStage;
  reason: string;
  priority: Priority;
  confidence: RouterConfidence;
  /** Why the router believes its own confidence rating — logged, never acted on. */
  confidence_reason: string;
  /**
   * What the decision is based on: `F-n` finding ids, `REQ-NNN`, `Mnn`, or
   * file:line references. Required and non-empty. A routing decision with no
   * evidence is a guess, and docs/okf.md §3.1 is explicit about how often
   * guesses at failure attribution are wrong.
   */
  evidence: string[];
  /** The `F-n` ids from docs/feedback_log.md this decision answers. */
  finding_ids: string[];
}

/**
 * Why the orchestrator stopped instead of enacting a routing decision.
 *
 * These are exactly the five reasons the pipeline's own generated design uses
 * (docs/lld.md §M12 `Escalation.reason`); the design lists more, but only
 * these five are reachable from the Phase 5 go-back gate.
 */
export type EscalationReason =
  | "low-confidence"
  | "cap-reached"
  | "budget-insufficient"
  | "guard-violation"
  | "contract-violation";

/**
 * What the orchestrator did with a decision.
 *
 * "deferred" is its own outcome rather than a flavour of "escalated": only one
 * decision is enacted per drain (docs/lld.md §M28), and the ones left behind
 * were never judged on their merits. Recording them as escalations would
 * poison the very accuracy measurement this log exists for.
 */
export type RoutingOutcome = "enacted" | "escalated" | "deferred";

/**
 * One line of state/routing.jsonl.
 *
 * docs/okf.md §3.5 asks, as an open question, "Should routing decisions be
 * logged as data, so their accuracy can be measured over time?" This record is
 * the answer: every decision is written down whether or not it was acted on,
 * with the evidence it rested on and the gate that judged it. Without the
 * rejected ones the log would only measure the decisions that already passed
 * the confidence filter, which is the sample that cannot tell you anything.
 */
export interface RoutingLogEntry {
  id: string;
  ts: string;
  /** The stage that was running when the feedback was produced (reviewer, in v1). */
  origin_stage: PipelineStage;
  target_stage: PipelineStage;
  reason: string;
  priority: Priority;
  confidence: RouterConfidence;
  confidence_reason: string;
  evidence: string[];
  finding_ids: string[];
  /** Which gate rule decided this, in words, for later accuracy analysis. */
  gate: string;
  enacted: boolean;
  outcome: RoutingOutcome;
  escalation: EscalationReason | null;
  /** Coarse forecast of what enacting would cost, and what was left at the time. */
  estimate_usd: number;
  remaining_usd: number;
  go_backs_used: number;
}
