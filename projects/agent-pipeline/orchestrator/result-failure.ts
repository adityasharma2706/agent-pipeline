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
  | { kind: "deterministic"; failure: DeterministicFailure }
  | { kind: "limit"; limit: UsageLimit };

// ---------------------------------------------------------------------------
// The third category: an ENVIRONMENTAL BLOCK.
//
// A fatal config fault throws and is never retried. A transient SDK error is
// retried. A usage/session/rate limit is neither: the agent never ran, nothing
// was written, and no amount of retrying can succeed until the provider's
// clock says so. Charging it to MAX_ATTEMPTS_PER_MODULE blames the module for
// the account's billing state — which is exactly what happened on a live run:
//
//   M05  failure  0 files  $0.8030   ... You've hit your session limit ...
//   M05  failure  0 files  $0.0000   ... You've hit your session limit ...
//   M05  failure  0 files  $0.0000   ... You've hit your session limit ...
//
// Three attempts gone, and the NEXT run halts on M05 with "no budget left"
// while nothing is wrong with M05. So this halts the run without recording an
// attempt at all.
// ---------------------------------------------------------------------------

/** A detected usage/session/rate limit, with the provider's own words kept. */
export interface UsageLimit {
  /** Which signal matched, for the log line and for tests. */
  signal: UsageLimitSignal;
  /** The provider's message, verbatim and untruncated as far as we received it. */
  providerText: string;
  /**
   * The provider's own reset phrasing, e.g. "resets 11:50am (Asia/Calcutta)",
   * quoted exactly as received. Deliberately NOT parsed into a timestamp: the
   * format is the provider's to change, and a wrong local time here would be
   * worse than no time at all.
   */
  resetHint: string | null;
}

export type UsageLimitSignal = "session limit" | "usage limit" | "rate limit" | "quota";

/**
 * The signals we are willing to treat as "do not retry, do not blame the
 * module".
 *
 * Chosen to be narrow on purpose. A false positive here means a REAL failure is
 * never retried and the run halts telling a human their account is throttled
 * when it is not — so each pattern requires the word "limit" or "quota" with
 * its own qualifier attached, rather than any mention of "limit" (which appears
 * in "max turns limit", "structured-output retry limit", and in ordinary model
 * prose) or any mention of "quota" alone.
 *
 * Wording varies between providers and between the CLI's own phrasings, which
 * is why this matches a handful of phrases case-insensitively instead of the
 * one observed sentence ("You've hit your session limit · resets 11:50am
 * (Asia/Calcutta)"). Anything that matches nothing falls through to the
 * existing transient/deterministic behaviour, which is the safe default.
 */
const USAGE_LIMIT_PATTERNS: readonly { signal: UsageLimitSignal; re: RegExp }[] = [
  // "You've hit your session limit", "session limit reached".
  { signal: "session limit", re: /\bsession limit\b/i },
  // "usage limit reached", "monthly usage limit".
  { signal: "usage limit", re: /\busage limit\b/i },
  // "rate limit exceeded", "rate_limit_error", "rate-limited".
  { signal: "rate limit", re: /\brate[ _-]?limit(ed|s|_error)?\b/i },
  // Quota needs an exhaustion word: "quota" on its own shows up in capability
  // descriptions and in unrelated tool output.
  { signal: "quota", re: /\bquota\b[^.\n]{0,40}\b(exceeded|exhausted|reached|remaining)\b/i },
  { signal: "quota", re: /\b(exceeded|exhausted|out of|no remaining)\b[^.\n]{0,40}\bquota\b/i },
];

/** "resets 11:50am (Asia/Calcutta)" / "try again at 3pm", echoed, never parsed. */
const RESET_HINT_RE = /\b(resets?(?: at)?|try again(?: at| in)?|available again(?: at)?)\b[^\n]*/i;

/**
 * Detects an environmental limit in whatever text the SDK gave us — a thrown
 * error's message, or a result message's error text.
 *
 * Returns null when unsure. The caller then behaves exactly as it did before
 * this function existed.
 */
export function detectUsageLimit(text: string | null | undefined): UsageLimit | null {
  if (typeof text !== "string" || text.trim().length === 0) return null;
  for (const { signal, re } of USAGE_LIMIT_PATTERNS) {
    if (!re.test(text)) continue;
    const hint = RESET_HINT_RE.exec(text);
    return {
      signal,
      providerText: text.trim(),
      resetHint: hint === null ? null : hint[0].trim(),
    };
  }
  return null;
}

/**
 * Thrown instead of recording a failed attempt. main()'s catch prints it as a
 * halt, exactly like DeterministicStageFailure — same idiom, different cause.
 */
export class UsageLimitHalt extends Error {
  readonly limit: UsageLimit;

  constructor(message: string, limit: UsageLimit) {
    super(message);
    this.name = "UsageLimitHalt";
    this.limit = limit;
  }
}

export interface UsageLimitHaltContext {
  /** Stage name, or "spec-implementer/M05". */
  label: string;
  limit: UsageLimit;
  /** What this blocked call was billed, usually $0.00 and sometimes not. */
  costUsd: number;
}

/**
 * The halt message for an environmental limit.
 *
 * Short on purpose, and the opposite of every other halt message in this file.
 * Those are long because a human has a real decision to make — accept the
 * artifact, raise a cap, fix the code by hand. Here there is no decision: the
 * account is throttled, nothing is broken, and the only action is to wait. The
 * message this replaced offered three remedies, none of which applied, and
 * claimed the failed attempts had been "INFORMED by the previous attempt's
 * exact diagnostics" when the agent had never run at all.
 */
export function buildUsageLimitHaltMessage(ctx: UsageLimitHaltContext): string {
  const lines: string[] = [
    `Stopped at "${ctx.label}": this Claude account has hit a usage limit.`,
    ``,
    `  provider said: ${ctx.limit.providerText}`,
  ];
  if (ctx.limit.resetHint !== null) {
    lines.push(`  resets:        ${ctx.limit.resetHint} (the provider's wording, quoted as-is)`);
  }
  lines.push(
    `  cost:          ${usd(ctx.costUsd)}`,
    ``,
    `NOTHING IS WRONG WITH THE CODE, THE PLAN, OR THE PIPELINE. The agent never ran, so`,
    `this was not counted as an attempt and no retry budget was spent on it.`,
    ``,
    `Wait for the limit to reset, then run the same command again:`,
    ``,
    `  npm run orchestrator`,
    ``,
    `Completed modules are skipped, not rebuilt.`
  );
  return lines.join("\n");
}

/**
 * Whatever error prose a result message carries: the `errors` array on the
 * error variants, or `result` on a `success`-subtype message flagged is_error.
 * Defensive about both, for the same reason classifyResult is below.
 */
function resultErrorText(message: SDKResultMessage): string {
  if (message.subtype === "success") {
    return typeof message.result === "string" ? message.result : "";
  }
  const raw: unknown = message.errors;
  if (!Array.isArray(raw)) return "";
  return (raw as unknown[]).filter((entry): entry is string => typeof entry === "string").join(" | ");
}

/**
 * Classifies one `type: "result"` message.
 *
 * `subtype: "success"` with `is_error: true` is classified TRANSIENT rather
 * than deterministic: it is not one of the named caps, and the pre-existing
 * behaviour for it (retry) is the conservative choice.
 */
export function classifyResult(message: SDKResultMessage): ResultClassification {
  if (message.subtype === "success" && !message.is_error) return { kind: "success" };

  // Before anything else: an environmental limit is not the module's failure
  // and not a cap of ours. In practice the CLI raises this as a thrown error
  // rather than a result message (runQueryOnce's catch handles that path), but
  // the same text can arrive here, and it must mean the same thing in both.
  const limit = detectUsageLimit(resultErrorText(message));
  if (limit !== null) return { kind: "limit", limit };

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

// ---------------------------------------------------------------------------
// A module that used up its per-module attempt budget.
//
// Same shape and same reasoning as the deterministic halt above: stop, and spend
// the message on telling a human something they can act on. The difference is
// only in what ran out — a cap inside one call there, the number of calls here.
// ---------------------------------------------------------------------------

/** What the last failed attempt at the module knew. Mirrors ModuleFailureRecord. */
export interface ModuleAttemptFailure {
  kind: string;
  reason: string;
  typecheckErrors: readonly string[];
  stubFindings: readonly string[];
  unownedReqs: readonly string[];
}

export interface ModuleExhaustedHaltContext {
  /** The stage running the module loop, i.e. "spec-implementer". */
  stage: string;
  moduleId: string;
  moduleTitle: string;
  /** 1-based position in the dependency-ordered plan, and the plan's size. */
  position: number;
  moduleCount: number;
  /** Attempts already recorded as failures for this module, and the budget. */
  attemptsUsed: number;
  maxAttempts: number;
  /** What every attempt at this module has cost, summed from the ledger. */
  costUsd: number;
  /** The last attempt's rejection. */
  failure: ModuleAttemptFailure;
  /** Workspace-relative paths the last attempt left behind, re-checked on disk. */
  filesWritten: readonly string[];
  /** Absolute workspace root, so the paths above can be acted on. */
  workspaceRoot: string;
  /** Absolute path of the ledger a human would edit to release the module. */
  ledgerPath: string;
  /** Module ids after this one that were not attempted. */
  notAttempted: readonly string[];
}

/** Thrown instead of attempting a module a fourth time. main()'s catch prints it. */
export class ModuleAttemptsExhausted extends Error {
  readonly moduleId: string;

  constructor(message: string, moduleId: string) {
    super(message);
    this.name = "ModuleAttemptsExhausted";
    this.moduleId = moduleId;
  }
}

/** Indented block of at most MAX_HALT_EVIDENCE_LINES lines, or nothing. */
const MAX_HALT_EVIDENCE_LINES = 10;

function evidenceBlock(label: string, lines: readonly string[]): string[] {
  if (lines.length === 0) return [];
  const shown = lines.slice(0, MAX_HALT_EVIDENCE_LINES);
  const out = [`  ${label}`, ...shown.map((line) => `    ${line}`)];
  if (lines.length > shown.length) {
    out.push(`    ...and ${lines.length - shown.length} more (all of them are in the ledger)`);
  }
  return out;
}

/**
 * Whether the recorded failure carries anything an informed retry could have
 * been built from. An "sdk" failure — the call itself did not complete — does
 * not, and the halt message must not claim otherwise.
 */
function hasDiagnostics(failure: ModuleAttemptFailure): boolean {
  return (
    failure.typecheckErrors.length > 0 ||
    failure.stubFindings.length > 0 ||
    failure.unownedReqs.length > 0
  );
}

/** The diagnostics of the last attempt, whichever kind it was. */
function failureEvidence(failure: ModuleAttemptFailure): string[] {
  return [
    ...evidenceBlock("tsc --noEmit said:", failure.typecheckErrors),
    ...evidenceBlock("placeholder markers found:", failure.stubFindings),
    ...evidenceBlock(
      "REQ IDs claimed that this module does not own:",
      failure.unownedReqs.length > 0 ? [failure.unownedReqs.join(", ")] : []
    ),
  ];
}

/**
 * The halt message for a module that failed its whole attempt budget.
 *
 * Verbose on purpose, for the same reason buildDeterministicHaltMessage is: the
 * run has stopped with a partly-built product on disk, and the next thing that
 * happens is a human deciding what to do. Everything they need to decide —
 * which module, what it broke, which files are theirs to look at, and how to let
 * the run continue afterwards — is here rather than in the scrollback.
 */
export function buildModuleExhaustedHaltMessage(ctx: ModuleExhaustedHaltContext): string {
  const lines: string[] = [
    `Module ${ctx.moduleId} failed ${ctx.attemptsUsed} attempt(s) and has no budget left ` +
      `(MAX_ATTEMPTS_PER_MODULE = ${ctx.maxAttempts}). Stage "${ctx.stage}" stopped here.`,
    ``,
    `  module:   ${ctx.moduleId} ${ctx.moduleTitle} (module ${ctx.position} of ${ctx.moduleCount})`,
    `  attempts: ${ctx.attemptsUsed} of ${ctx.maxAttempts}, costing ${usd(ctx.costUsd)} in total`,
    `  rejected: ${ctx.failure.kind} — ${ctx.failure.reason.split("\n")[0] ?? ""}`,
  ];

  lines.push(...failureEvidence(ctx.failure));

  if (ctx.filesWritten.length > 0) {
    lines.push(
      ...evidenceBlock(`files the last attempt left in ${ctx.workspaceRoot}:`, [...ctx.filesWritten])
    );
  } else {
    lines.push(`  files:    the last attempt left nothing on disk to look at.`);
  }

  lines.push(
    ``,
    `The loop did NOT move on to the next module. docs/implementer.md is dependency-ordered`,
    `and later modules import this one, so building on top of a module that never passed`,
    `verification buys a cascade of failures at full price.`
  );

  if (ctx.notAttempted.length > 0) {
    const shown = ctx.notAttempted.slice(0, 8).join(", ");
    const elided = ctx.notAttempted.length > 8 ? `, ... (${ctx.notAttempted.length} in all)` : ".";
    lines.push(`${ctx.notAttempted.length} module(s) were therefore not attempted: ${shown}${elided}`);
  }

  // Only true when the attempts actually produced diagnostics to carry forward.
  // An SDK-level failure (the call never completed) has none, and claiming it
  // did is how a human gets sent looking for evidence that does not exist.
  const informed = ctx.attemptsUsed > 1 && hasDiagnostics(ctx.failure);
  if (informed) {
    lines.push(
      ``,
      `Attempts 2 and ${ctx.maxAttempts} were INFORMED — each was given the previous attempt's exact`,
      `diagnostics and told to repair its own files (orchestrator/retry-context.ts). They still`,
      `did not converge, so another identical-in-spirit attempt is money spent on the same`,
      `outcome. This is the point where a human is cheaper than the model.`
    );
  } else {
    lines.push(
      ``,
      `The attempts produced no diagnostics to carry forward — the failures were at the SDK`,
      `call level rather than at verification — so each retry started from the same place as`,
      `the first. Re-running as-is is unlikely to end differently.`
    );
  }

  lines.push(``, `WHAT YOU CAN DO, cheapest first:`, ``);

  if (ctx.filesWritten.length > 0) {
    lines.push(
      `1. Fix the files yourself, in the workspace. They are listed above and are real code,`,
      `   not a draft — the rest of the module passed every check that is not named above.`,
      `   Then mark the attempt good, by editing the LAST ${ctx.moduleId} entry in:`
    );
  } else {
    lines.push(
      `1. Write the module yourself, in the workspace — the attempts left nothing on disk to`,
      `   repair. Then mark the attempt good, by editing the LAST ${ctx.moduleId} entry in:`
    );
  }

  lines.push(
    ``,
    `     ${ctx.ledgerPath}`,
    ``,
    `   ...setting its "outcome" to "success". The next run skips ${ctx.moduleId} and continues`,
    `   from the module after it. You are vouching for code the pipeline never passed, so run`,
    `   \`npx tsc --noEmit\` in the workspace yourself first.`,
    ``,
    `2. Give it a fresh budget, if you believe the failures were flukes rather than a`,
    `   systematic problem: delete the failed ${ctx.moduleId} entries from the same ledger and`,
    `   re-run. That costs another ${ctx.maxAttempts} attempts at full price, which is why it is`,
    `   not the first option and is not done automatically.`,
    ``,
    `3. Investigate the spec, if the module is being asked for something it cannot do —`,
    `   a dependency its \`Depends on:\` line does not name, a REQ that belongs elsewhere,`,
    `   a design the plan never settled. Read the ${ctx.moduleId} section of docs/implementer.md`,
    informed
      ? `   against the diagnostics above. If the plan is wrong, no number of retries fixes it,`
      : `   and judge it on its own. If the plan is wrong, no number of retries fixes it,`,
    `   and the repair is a go-back to implementation-planning rather than another build.`,
    ``,
    `Nothing was lost. Every module that passed is recorded in the ledger and will be`,
    `skipped, not rebuilt, and the stage retry budget in state/run.json was NOT spent on`,
    `this — a module failing is not the stage failing.`
  );

  return lines.join("\n");
}
