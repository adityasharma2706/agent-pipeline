// orchestrator/result-failure.ts
//
// Which SDK result failures are worth retrying, and what to tell a human about
// the ones that are not.
//
// THE BUG THIS FILE EXISTS FOR. runQueryOnce used to collapse every result
// message into one boolean:
//
//     const ok = message.subtype === "success" && !message.is_error;
//
// The control loop then treated every `ok: false` the same way: recordRetry,
// run the identical call again, up to MAX_RETRIES_PER_STAGE. That is correct
// for `error_during_execution` (a network blip, a transport error — retrying is
// exactly what the retry budget is for) and WRONG for the three cap errors.
// `error_max_budget_usd` means the same prompt against the same maxBudgetUsd
// exhausted the cap; running it again exhausts it again. A live run of the
// system-design stage did this four times at a $4.00 cap — and docs/hld.md had
// been written completely on the FIRST attempt, then thrown away unread.
//
// So the split here is the same one runStage already makes between fatal
// configuration faults (a missing STAGE_IO entry, a missing agents/<stage>.md —
// thrown, never retried) and transient SDK errors (caught, retried). It was
// simply never applied to result SUBTYPES. Deterministic failures now throw a
// DeterministicStageFailure, which main()'s catch prints as a halt.
//
// Nothing here imports the SDK at runtime — `SDKResultMessage` is an
// `import type`, erased at compile time — so classification and the halt
// message can be exercised by a scratchpad script against hand-built result
// objects, with no import path to query() and nothing billable.

import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";

/**
 * Result subtypes that will produce the identical failure on an identical
 * re-run. The SDK's full error set is
 *   'error_during_execution' | 'error_max_turns' | 'error_max_budget_usd'
 *   | 'error_max_structured_output_retries'
 * and `error_during_execution` is deliberately NOT here: it is the one that may
 * genuinely be transient, and it keeps its retry budget.
 */
export const DETERMINISTIC_RESULT_SUBTYPES = [
  "error_max_budget_usd",
  "error_max_turns",
  "error_max_structured_output_retries",
] as const;

export type DeterministicSubtype = (typeof DETERMINISTIC_RESULT_SUBTYPES)[number];

export function isDeterministicSubtype(subtype: string): subtype is DeterministicSubtype {
  return (DETERMINISTIC_RESULT_SUBTYPES as readonly string[]).includes(subtype);
}

export interface DeterministicFailure {
  subtype: DeterministicSubtype;
  /** Whatever the SDK said about it, verbatim; usually empty. */
  errors: string[];
}

export type ResultClassification =
  | { kind: "success" }
  | { kind: "transient"; subtype: string }
  | { kind: "deterministic"; failure: DeterministicFailure };

/**
 * Classifies one `type: "result"` message.
 *
 * `subtype: "success"` with `is_error: true` is classified TRANSIENT rather
 * than deterministic: it is not one of the named caps, and the pre-existing
 * behaviour for it (retry) is the conservative choice.
 */
export function classifyResult(message: SDKResultMessage): ResultClassification {
  if (message.subtype === "success" && !message.is_error) return { kind: "success" };
  // `message.subtype !== "success"` first: that is what narrows the union to
  // SDKResultError, which is the variant carrying `errors`. isDeterministic-
  // Subtype alone is a guard over `string` and narrows nothing.
  if (message.subtype !== "success" && isDeterministicSubtype(message.subtype)) {
    // Defensive rather than pedantic: the SDK types `errors` as required, but
    // "older producers" are called out in its own docs and a missing field here
    // must not take down the halt message.
    const raw: unknown = message.errors;
    const errors: unknown[] = Array.isArray(raw) ? (raw as unknown[]) : [];
    return {
      kind: "deterministic",
      failure: {
        subtype: message.subtype,
        errors: errors.filter((entry): entry is string => typeof entry === "string"),
      },
    };
  }
  return { kind: "transient", subtype: message.is_error ? `${message.subtype} (is_error)` : message.subtype };
}

/**
 * What a capped call left on disk, checked by exactly the same rule the success
 * path uses — `hasRealContent` for a document, the module verification for the
 * workspace stage. This is the part that would have saved the money: the
 * evidence existed on attempt one and was discarded without being looked at.
 *
 * `null` means the call produces no on-disk artifact at all (feedback-router,
 * critic), which is different from "produced nothing".
 */
export interface ArtifactStatus {
  /** What was expected, e.g. "docs/hld.md". */
  description: string;
  /** True when it passes the success path's own verification. */
  complete: boolean;
  /** One line of evidence for the line above. */
  detail: string;
}

export interface DeterministicHaltContext {
  /** Stage name, or "spec-implementer/M07", or "feedback-router". */
  label: string;
  failure: DeterministicFailure;
  costUsd: number;
  numTurns: number;
  /** What this specific call was allowed to spend (per-stage cap, clamped to the run budget). */
  allowanceUsd: number;
  /** The unclamped per-call cap constant's current value. */
  perStageCapUsd: number;
  artifact: ArtifactStatus | null;
  /** The exact command that would accept the artifact, when one applies. */
  acceptCommand: string | null;
}

/** Thrown instead of retrying. main()'s catch prints `err.message` as the halt. */
export class DeterministicStageFailure extends Error {
  readonly subtype: DeterministicSubtype;

  constructor(message: string, subtype: DeterministicSubtype) {
    super(message);
    this.name = "DeterministicStageFailure";
    this.subtype = subtype;
  }
}

function usd(value: number): string {
  return `$${value.toFixed(4)}`;
}

/** The line naming the cap that was actually hit. */
function capLine(ctx: DeterministicHaltContext): string {
  switch (ctx.failure.subtype) {
    case "error_max_budget_usd":
      return (
        `  cap hit:  MAX_BUDGET_USD_PER_STAGE = $${ctx.perStageCapUsd.toFixed(2)} ` +
        `(orchestrator/run.ts); this call was allowed ${usd(ctx.allowanceUsd)}`
      );
    case "error_max_turns":
      return `  cap hit:  the SDK's max-turns limit, after ${ctx.numTurns} turns`;
    case "error_max_structured_output_retries":
      return `  cap hit:  the SDK's structured-output retry limit (the schema was never satisfied)`;
  }
}

/** What a human should change to get past the cap. */
function remedyLines(ctx: DeterministicHaltContext): string[] {
  switch (ctx.failure.subtype) {
    case "error_max_budget_usd":
      return [
        `To let this stage finish, raise MAX_BUDGET_USD_PER_STAGE in orchestrator/run.ts:`,
        ``,
        `  currently  $${ctx.perStageCapUsd.toFixed(2)}`,
        `  spent here ${usd(ctx.costUsd)} and was still not done`,
        `  so set it  above ${usd(ctx.costUsd)} — the cost of the work that got cut off is`,
        `             unknown, so allow real headroom rather than a few cents more.`,
        ``,
        `Cost scales with the size of the documents a stage reads and writes, and that`,
        `constant was calibrated against an earlier, smaller plan. The "inputs read" line`,
        `above is the number to sanity-check it against before picking a new one.`,
      ];
    case "error_max_turns":
      return [
        `This orchestrator does not set \`maxTurns\`, so this was the SDK default. The call`,
        `is being asked for more work than one conversation can finish. Either give the`,
        `stage less to do per call, or set \`maxTurns\` explicitly in runQueryOnce().`,
      ];
    case "error_max_structured_output_retries":
      return [
        `The agent could not produce output matching its JSON schema, and the SDK already`,
        `retried it internally. Re-running the identical call will not fix that: the schema`,
        `(ROUTER_OUTPUT_SCHEMA in orchestrator/router.ts) or the agent's instructions need`,
        `to change.`,
      ];
  }
}

/**
 * The halt message. Deliberately verbose: this is the only thing standing
 * between a human and paying to redo work that is already sitting on disk.
 */
export function buildDeterministicHaltMessage(ctx: DeterministicHaltContext): string {
  const lines: string[] = [
    `Stage "${ctx.label}" hit a deterministic cap and was NOT retried: ${ctx.failure.subtype}.`,
    ``,
    capLine(ctx),
    `  cost:     ${usd(ctx.costUsd)} over ${ctx.numTurns} turns`,
  ];

  if (ctx.artifact !== null) {
    lines.push(
      `  artifact: ${ctx.artifact.description} — ${ctx.artifact.complete ? "LOOKS COMPLETE" : "not usable"}`,
      `            ${ctx.artifact.detail}`
    );
  }
  if (ctx.failure.errors.length > 0) {
    lines.push(`  sdk said: ${ctx.failure.errors.join(" | ")}`);
  }

  lines.push(
    ``,
    `Retrying would run the identical call against the identical cap and fail the same`,
    `way, so the run stopped here. No retry was spent and no further money was spent.`
  );

  if (ctx.artifact !== null && ctx.artifact.complete) {
    lines.push(
      ``,
      `READ THE ARTIFACT BEFORE YOU SPEND ANYTHING. It was written by this call and`,
      `passes the same check a successful run applies, so the work may not need redoing`,
      `at all — a stage can hit its cap on the turn AFTER it finished writing.`
    );
    if (ctx.acceptCommand !== null) {
      lines.push(
        ``,
        `If it is good, accept it without re-running the stage:`,
        ``,
        `  ${ctx.acceptCommand}`,
        ``,
        `That records the stage as successful in state/run.json and lets the run continue`,
        `from the next stage. It does not re-verify anything a human can judge: you are`,
        `vouching for a document produced by a call that hit its cap.`
      );
    }
  } else if (ctx.artifact !== null) {
    lines.push(
      ``,
      `The artifact is not usable, so there is nothing to accept — the work does have to`,
      `be redone.`
    );
  }

  lines.push(``, ...remedyLines(ctx));
  return lines.join("\n");
}
