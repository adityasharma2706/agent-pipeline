// The feedback-router's contract and its gate.
//
// Everything in this file is PURE: a JSON schema, a runtime validator, and a
// decision gate. There is deliberately no import of `query()` here — the SDK
// call lives in run.ts. That split is what lets the gate and the validator be
// exercised against hand-written router output without an API key, without a
// billable call, and without any import path that could reach one by accident.

import { PIPELINE_STAGES } from "./types.js";
import type {
  EscalationReason,
  FeedbackRouterDecision,
  PipelineStage,
  Priority,
  RouterConfidence,
} from "./types.js";

/**
 * `router.maxGoBacksPerRun`, default 3.
 *
 * Not invented here: it is this project's own generated design speaking, at
 * docs/lld.md §M01 defaults ("`maxGoBacksPerRun 3`"), adopted so the
 * orchestrator and the pipeline it is building agree on the number. Overridable
 * per run with `--max-go-backs N`, which is the same flag mapping §M01 records
 * (`--max-go-backs` → `router.maxGoBacksPerRun`).
 */
export const DEFAULT_MAX_GO_BACKS_PER_RUN = 3;

/**
 * `router.autoProceedMinConfidence`, default 'high' (docs/lld.md §M01).
 *
 * THIS IS THE CORE SAFETY PROPERTY OF THE WHOLE FEEDBACK LOOP, AND IT IS
 * EVIDENCE-BASED, NOT CAUTION FOR ITS OWN SAKE. DO NOT "SIMPLIFY" IT AWAY.
 *
 * Automated failure attribution — "which agent/stage is responsible for this
 * observed failure?" — is an open research problem, not a solved one.
 * docs/okf.md §3.1 records the measurements:
 *
 *   - Who&When (ICML 2025 spotlight, arXiv 2505.00212), over failure logs from
 *     127 multi-agent systems: the BEST method identifies the responsible agent
 *     53.5% of the time (14.2% at step level). Some methods score below random.
 *   - AgenTracer (ICLR 2026, arXiv 2509.03312), a purpose-trained 8B attribution
 *     model: ~69% agent-level. That is the state of the art, and it is a model
 *     trained for exactly this job.
 *
 * A router that trusts its own attribution unconditionally is therefore wrong
 * something like a third to a half of the time — and every wrong answer costs a
 * full re-run of the target stage AND every stage downstream of it (see the
 * go-back cost note in run.ts). Wrong attribution is not a small error here; it
 * is the most expensive error available.
 *
 * So only `high` confidence auto-routes. `medium` and `low` both halt and
 * report for a human with escalation reason 'low-confidence'. docs/lld.md §M27
 * gate step 6 allows medium to *ask the user* when the run is attended; this
 * orchestrator has no attended mode — there is no human sitting at the process
 * to answer — and §M27 is explicit that "`ask-user` in unattended mode always
 * becomes escalate". So medium escalating is that rule applied, not a
 * departure from it.
 */
export const ROUTER_AUTO_PROCEED_MIN_CONFIDENCE: RouterConfidence = "high";

/**
 * The JSON schema handed to the SDK as `options.outputFormat`.
 *
 * The router returns its decisions as STRUCTURED OUTPUT, arriving on
 * `SDKResultSuccess.structured_output`. It is never scraped out of prose: a
 * regex over an assistant's paragraph is a parser that fails silently and
 * changes behaviour whenever the model's phrasing drifts, and what is being
 * parsed here is an instruction to spend money re-running stages.
 *
 * `id` is absent on purpose. `RD-n` is allocated by the orchestrator from the
 * routing log (docs/lld.md §base: monotonic per project, max existing id + 1);
 * letting the agent number its own decisions would produce collisions across
 * runs and make the log unjoinable.
 */
export const ROUTER_OUTPUT_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["decisions"],
  properties: {
    decisions: {
      type: "array",
      description:
        "One routing decision per feedback item, or an empty array if nothing needs routing.",
      items: {
        type: "object",
        additionalProperties: false,
        required: [
          "finding_ids",
          "target_stage",
          "reason",
          "priority",
          "confidence",
          "confidence_reason",
          "evidence",
        ],
        properties: {
          finding_ids: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            description: "The F-n finding ids from docs/feedback_log.md this decision answers.",
          },
          target_stage: {
            type: "string",
            enum: [...PIPELINE_STAGES],
            description: "The earlier pipeline stage to re-run. Must be EARLIER than the stage that produced the feedback.",
          },
          reason: { type: "string" },
          priority: { type: "string", enum: ["low", "medium", "high"] },
          confidence: {
            type: "string",
            enum: ["low", "medium", "high"],
            description:
              "How sure you are that target_stage is where the problem originated. Use 'high' ONLY when the evidence names the stage directly; only 'high' is acted on automatically.",
          },
          confidence_reason: { type: "string" },
          evidence: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            description:
              "F-n ids, REQ-NNN ids, Mnn module ids, or file:line references. A decision with no evidence is a guess.",
          },
        },
      },
    },
  },
};

const PRIORITIES: readonly string[] = ["low", "medium", "high"];

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** A decision as the AGENT returns it: everything but the orchestrator-assigned id. */
type RawDecision = Omit<FeedbackRouterDecision, "id">;

export type RouterParseResult =
  | { ok: true; decisions: RawDecision[] }
  | { ok: false; error: string };

/**
 * Validates `structured_output` against the shape above.
 *
 * The SDK types `structured_output` as `unknown`, and that is the honest type:
 * schema-constrained decoding is a strong constraint, not a guarantee, and the
 * field is also simply absent when a turn ends without producing one. So it is
 * validated here regardless. A malformed decision set must be a CLEAN FAILURE
 * with a message naming what was wrong — never a crash, and never a partially
 * trusted object that reaches the gate with an undefined target_stage.
 */
export function parseRouterDecisions(raw: unknown): RouterParseResult {
  if (raw === undefined || raw === null) {
    return {
      ok: false,
      error:
        "the router returned no structured_output at all (the turn ended without producing one, " +
        "or the SDK exhausted its structured-output retries)",
    };
  }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: `structured_output is ${Array.isArray(raw) ? "an array" : typeof raw}, expected an object` };
  }

  const root = raw as Record<string, unknown>;
  const decisions = root.decisions;
  if (!Array.isArray(decisions)) {
    return { ok: false, error: 'structured_output has no "decisions" array' };
  }

  const parsed: RawDecision[] = [];
  for (let i = 0; i < decisions.length; i += 1) {
    const at = `decisions[${i}]`;
    const item: unknown = decisions[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: `${at} is not an object` };
    }
    const d = item as Record<string, unknown>;

    if (typeof d.target_stage !== "string") {
      return { ok: false, error: `${at}.target_stage is missing or not a string` };
    }
    if (!(PIPELINE_STAGES as readonly string[]).includes(d.target_stage)) {
      return {
        ok: false,
        error: `${at}.target_stage is "${d.target_stage}", which is not a pipeline stage`,
      };
    }
    if (typeof d.reason !== "string" || d.reason.trim().length === 0) {
      return { ok: false, error: `${at}.reason is missing or empty` };
    }
    if (typeof d.priority !== "string" || !PRIORITIES.includes(d.priority)) {
      return { ok: false, error: `${at}.priority is not one of low|medium|high` };
    }
    if (typeof d.confidence !== "string" || !PRIORITIES.includes(d.confidence)) {
      return { ok: false, error: `${at}.confidence is not one of low|medium|high` };
    }
    if (typeof d.confidence_reason !== "string") {
      return { ok: false, error: `${at}.confidence_reason is missing or not a string` };
    }
    if (!isStringArray(d.evidence) || d.evidence.length === 0) {
      return {
        ok: false,
        error:
          `${at}.evidence is missing, not an array of strings, or empty — a routing decision ` +
          `without evidence cannot be judged, so it is rejected rather than trusted`,
      };
    }
    if (!isStringArray(d.finding_ids) || d.finding_ids.length === 0) {
      return { ok: false, error: `${at}.finding_ids is missing, not an array of strings, or empty` };
    }

    parsed.push({
      target_stage: d.target_stage as PipelineStage,
      reason: d.reason,
      priority: d.priority as Priority,
      confidence: d.confidence as RouterConfidence,
      confidence_reason: d.confidence_reason,
      evidence: [...d.evidence],
      finding_ids: [...d.finding_ids],
    });
  }

  return { ok: true, decisions: parsed };
}

/** Everything the gate needs that is not on the decision itself. */
export interface GateContext {
  /** The stage whose output produced this feedback — reviewer, in v1. */
  originStage: PipelineStage;
  goBacksUsed: number;
  maxGoBacksPerRun: number;
  /** What enacting this decision is forecast to cost, in USD. */
  estimateUsd: number;
  /** What is left of the cumulative run budget right now. */
  remainingUsd: number;
  /** Whether a stage has an implementation in this build at all. */
  isImplemented: (stage: PipelineStage) => boolean;
}

/**
 * `escalation`/`summary` are present-and-null on the enact branch rather than
 * absent, so callers can widen this union (run.ts adds a "deferred" case)
 * without restructuring it.
 */
export type GateVerdict =
  | { enact: true; gate: string; escalation: null; summary: null }
  | { enact: false; gate: string; escalation: EscalationReason; summary: string };

/**
 * Decides whether a routing decision may be acted on. Every rule here is REAL —
 * each one can stop the run — and none of them is advisory.
 *
 * Order, and where it differs from the generated design. docs/lld.md §M27 runs
 * the caps first (`cap-reached`, then `budget-insufficient`, then confidence).
 * The two structural checks are hoisted ABOVE the caps here, because a decision
 * naming a stage that does not exist or that sits FORWARD of the origin is
 * malformed, and reporting a malformed decision as "out of budget" would send a
 * human to look at the wrong thing entirely. Among the rules that are all about
 * affordability, §M27's order is kept exactly.
 */
export function gateDecision(
  decision: FeedbackRouterDecision,
  ctx: GateContext
): GateVerdict {
  const targetIndex = PIPELINE_STAGES.indexOf(decision.target_stage);
  const originIndex = PIPELINE_STAGES.indexOf(ctx.originStage);

  // 1. The target must be a stage this build can actually run. Routing to
  //    testing-agent, which cannot ship before the M18 sandbox exists, would
  //    otherwise enact a go-back that is guaranteed to die on arrival.
  if (!ctx.isImplemented(decision.target_stage)) {
    return {
      enact: false,
      gate: "target-not-implemented",
      escalation: "guard-violation",
      summary:
        `${decision.id} targets "${decision.target_stage}", which has no implementation in this ` +
        `build. Enacting it would spend a go-back on a stage that cannot run.`,
    };
  }

  // 2. NEVER ROUTE FORWARD. A "go-back" to a later stage — or to the origin
  //    stage itself — is not a cheaper go-back, it is a contradiction: the
  //    feedback was produced BY the origin stage, so nothing at or after it can
  //    be the origin of the problem, and enacting one would put the control
  //    loop in a cycle that re-runs the reviewer on output it just reviewed.
  if (targetIndex >= originIndex) {
    return {
      enact: false,
      gate: "forward-route",
      escalation: "contract-violation",
      summary:
        `${decision.id} routes from "${ctx.originStage}" to "${decision.target_stage}", which is ` +
        `not earlier in the pipeline. A go-back must go back.`,
    };
  }

  // 3. docs/lld.md §M27 gate step 1: the per-run go-back cap.
  if (ctx.goBacksUsed >= ctx.maxGoBacksPerRun) {
    return {
      enact: false,
      gate: "max-go-backs",
      escalation: "cap-reached",
      summary:
        `${decision.id} would be go-back ${ctx.goBacksUsed + 1}, past the cap of ` +
        `${ctx.maxGoBacksPerRun} per run (router.maxGoBacksPerRun).`,
    };
  }

  // 4. §M27 gate step 3. Checked BEFORE starting, so a go-back that cannot be
  //    afforded escalates rather than beginning and dying halfway through with
  //    the money spent and the pipeline left in a worse state than it started.
  if (ctx.estimateUsd > ctx.remainingUsd) {
    return {
      enact: false,
      gate: "budget",
      escalation: "budget-insufficient",
      summary:
        `${decision.id} is estimated at $${ctx.estimateUsd.toFixed(2)} to re-run from ` +
        `"${decision.target_stage}", but only $${ctx.remainingUsd.toFixed(4)} is left in the run ` +
        `budget. Starting it would spend that and finish nothing.`,
    };
  }

  // 5. §M27 gate steps 5-7, and the reason the whole gate exists. See
  //    ROUTER_AUTO_PROCEED_MIN_CONFIDENCE above for the measurements.
  if (decision.confidence !== ROUTER_AUTO_PROCEED_MIN_CONFIDENCE) {
    return {
      enact: false,
      gate: "confidence",
      escalation: "low-confidence",
      summary:
        `${decision.id} is ${decision.confidence}-confidence; only ` +
        `${ROUTER_AUTO_PROCEED_MIN_CONFIDENCE} auto-routes. Router-stated reason: ` +
        `${decision.confidence_reason || "(none given)"}`,
    };
  }

  return { enact: true, gate: "auto-proceed:high-confidence", escalation: null, summary: null };
}

/**
 * The gate's verdict widened with the one case the gate itself never produces:
 * a decision set aside unjudged because another was enacted first in the same
 * drain.
 */
export type DecisionVerdict =
  | { enact: true; gate: string; escalation: null; summary: null }
  | { enact: false; gate: string; escalation: EscalationReason | null; summary: string | null };

export interface DrainItem {
  decision: FeedbackRouterDecision;
  verdict: DecisionVerdict;
  estimateUsd: number;
}

export interface DrainResult {
  /** Every decision, in the order it was judged, each with its verdict. */
  items: DrainItem[];
  /** The one decision to act on, or null if none cleared the gate. */
  enacted: FeedbackRouterDecision | null;
}

/** Gate context plus the cost model, which only the orchestrator knows. */
export type DrainContext = Omit<GateContext, "estimateUsd"> & {
  estimateUsd: (target: PipelineStage) => number;
};

/**
 * Judges a whole decision set. Pure: no I/O, no SDK, no clock — the caller
 * logs and prints the result.
 *
 * Decisions are judged EARLIEST TARGET FIRST, and exactly one is enacted per
 * drain (docs/lld.md §M28: "one issue enacted per drain"). Earliest-first is
 * not arbitrary: a go-back re-runs the target and everything downstream, so
 * going back the furthest subsumes every nearer target in the same pass.
 *
 * The decisions after the enacted one are marked `deferred`, NOT judged. The
 * go-back ends by re-running the reviewer, which re-derives the findings from
 * what is then true; pre-judging the remainder against a world that is about
 * to change would only write wrong data into the routing log.
 */
export function planDrain(
  decisions: readonly FeedbackRouterDecision[],
  ctx: DrainContext
): DrainResult {
  const ordered = [...decisions].sort(
    (a, b) => PIPELINE_STAGES.indexOf(a.target_stage) - PIPELINE_STAGES.indexOf(b.target_stage)
  );

  const items: DrainItem[] = [];
  let enacted: FeedbackRouterDecision | null = null;

  for (const decision of ordered) {
    const estimateUsd = ctx.estimateUsd(decision.target_stage);
    if (enacted !== null) {
      items.push({
        decision,
        estimateUsd,
        verdict: { enact: false, gate: "deferred-to-next-drain", escalation: null, summary: null },
      });
      continue;
    }

    const verdict = gateDecision(decision, { ...ctx, estimateUsd });
    if (verdict.enact) enacted = decision;
    items.push({ decision, estimateUsd, verdict });
  }

  return { items, enacted };
}
