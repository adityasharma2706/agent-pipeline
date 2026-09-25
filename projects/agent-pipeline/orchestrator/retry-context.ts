// What a retried module gets told about its own previous attempt.
//
// The bug this exists to fix: a module that failed verification was retried
// with a BYTE-IDENTICAL prompt. The orchestrator knew exactly what was wrong —
// it had the tsc diagnostics in its hand — and threw them away, so the agent
// re-rolled blind at full price, for every attempt in its budget. One live
// run paid $2.29 for the first attempt and would have paid it three more times
// for the same type error on the same line.
//
// So every failure is classified (the remedy for "line 131 has a type error" is
// nothing like the remedy for "you wrote placeholder code"), recorded in the
// workspace ledger, and rendered into a clearly-marked section of the NEXT
// attempt's prompt. The first attempt at a module never carries this section.
//
// This file deliberately imports nothing from progress.ts or verify.ts: both of
// them import FROM here (the ledger stores a ModuleFailureRecord, the verifier
// produces a ModuleFailureKind), and a cycle between them would be a real one.

/**
 * Which check rejected the previous attempt.
 *
 * These are exactly the failure kinds verifyModule already distinguishes, plus
 * "sdk" for a call that did not come back successfully at all. They are kept
 * apart because the repair instruction differs completely between them, and a
 * generic "the previous attempt failed, try harder" is the thing that gets
 * ignored.
 */
export type ModuleFailureKind = "no-files" | "req-claim" | "stub" | "typecheck" | "sdk";

/**
 * The machine-readable part of a failed attempt, as persisted in the workspace
 * progress ledger.
 *
 * `reason` alone is not enough: it is a human-readable sentence with the
 * diagnostics interpolated and truncated into it. Feeding that back would mean
 * re-parsing prose we already had structured, and would silently smuggle the
 * "...and 3 more" elision into the agent's only view of what it broke.
 */
export interface ModuleFailureRecord {
  kind: ModuleFailureKind;
  /** The one-line summary, matching the ledger entry's `failureReason`. */
  reason: string;
  /**
   * Real `tsc --noEmit` diagnostic lines, verbatim.
   *
   * TS2307 (unresolved import) lines are NOT in here and must never be: the
   * workspace has no node_modules and the agent has no shell, so every import
   * of anything produces one. They are expected, not the agent's fault, and
   * drowning the one real error in forty of them is how this gets ignored.
   */
  typecheckErrors: string[];
  /** `file:line — label: text` for each placeholder hit the stub scan found. */
  stubFindings: string[];
  /** REQ ids the attempt claimed that docs/implementer.md does not assign it. */
  unownedReqs: string[];
}

/**
 * The shape this module needs out of a ledger entry.
 *
 * Structural rather than an import of ModuleProgressEntry, so progress.ts can
 * depend on this file and not the reverse. ModuleProgressEntry satisfies it.
 */
export interface FailedAttemptSource {
  moduleId: string;
  outcome: "success" | "failure";
  finishedAt: string;
  failureReason: string | null;
  filesWritten: string[];
  failure?: ModuleFailureRecord;
}

/** A previous failed attempt at the module about to be retried. */
export interface PriorAttempt {
  record: ModuleFailureRecord;
  /** Workspace-relative paths the failed attempt touched. Still on disk. */
  filesWritten: string[];
  /** 1 for the first failure, 2 for the second, ... Counted by failedAttemptCount. */
  attemptNumber: number;
  /**
   * True when the failure was recorded by an EARLIER orchestrator process —
   * the run was stopped after the failure and the human re-ran. The agent is
   * told, because "your previous attempt" reads as a lie otherwise, and because
   * the files it is being asked to repair were written by a session it has no
   * memory of.
   */
  crossProcess: boolean;
  /**
   * True when the attempt DID write files but none of them are on disk any more
   * — a human reverted or cleaned the workspace between runs.
   *
   * It changes the instruction materially: the diagnosis still stands (that type
   * error was real), but "read and repair your files" is no longer possible and
   * telling the agent to do it sends it hunting for things that are not there.
   */
  filesVanished: boolean;
}

/**
 * The file paragraph for an attempt with no surviving files.
 *
 * Empty for the "no-files" kind: its diagnosis already says nothing reached
 * disk, and repeating it is the kind of padding that makes a section skimmable.
 */
function absentFilesParagraph(prior: PriorAttempt): string[] {
  return prior.record.kind === "no-files"
    ? []
    : [`That attempt left no files in the workspace.`];
}

/** Hard cap on diagnostics rendered into a prompt, so one broken file cannot flood it. */
const MAX_RENDERED_LINES = 20;

/**
 * How many times ONE module may be attempted before the stage halts.
 *
 * This is the per-module twin of MAX_RETRIES_PER_STAGE (orchestrator/state.ts),
 * and it exists because the two budgets count different things. A document stage
 * is one call producing one artifact, so "three attempts at the stage" is the
 * same sentence as "three attempts at the work". spec-implementer is a loop over
 * a whole plan — 53 modules in the current one — so charging a module's failure
 * to the STAGE counter means three failures spread anywhere across 53 modules
 * exhaust the budget for the entire build, and (because state.retries is
 * persisted and only `--accept-stage` clears it) every later run then halts on
 * its first failure with no attempts at all.
 *
 * 3 rather than more: attempts 2 and 3 are informed ones — they carry the exact
 * diagnostics of the previous failure (see renderRetryGuidance) — so a module
 * that has failed three times with the error in front of it is not converging,
 * and a fourth attempt is paying full price for the same outcome. 3 rather than
 * fewer: the one live failure this was measured against (M01, a single TS2322 on
 * one line) is exactly the kind that a first informed retry fixes.
 *
 * Attempts are counted from the workspace ledger, not from a counter in this
 * process — see failedAttemptCount.
 */
export const MAX_ATTEMPTS_PER_MODULE = 3;

/**
 * How many failed attempts at `moduleId` are already on record, counting only
 * those SINCE the module last succeeded.
 *
 * The ledger is the home for this count rather than state/run.json, for the same
 * reason the failure records themselves live there: the failing FILES are in the
 * workspace, and the count of attempts at them has to survive together with them
 * and with the diagnostics that describe them. A resumed run then knows both what
 * broke and how many times, from one read of one file, and a module can never be
 * charged for attempts made against a different workspace.
 *
 * Resetting at a success is what makes a go-back safe: a module that failed twice,
 * passed, and is being rebuilt against a revised plan starts from a full budget,
 * because those failures were against different input.
 */
export function failedAttemptCount(
  entries: readonly FailedAttemptSource[],
  moduleId: string
): number {
  let count = 0;
  for (const entry of entries) {
    if (entry.moduleId !== moduleId) continue;
    count = entry.outcome === "success" ? 0 : count + 1;
  }
  return count;
}

/**
 * The most recent failed attempt at `moduleId`, or null if the module has never
 * failed (or its last recorded attempt succeeded).
 *
 * Reads the ledger, which means this works identically for an in-process retry
 * and for a fresh process resuming after a halt — the retry loop re-enters
 * runModuleStage from the top either way, and the ledger is the only thing that
 * survives both. See the README for why the failure context is persisted rather
 * than held in memory for the lifetime of one process.
 *
 * A module whose latest entry is a success returns null even if it failed
 * earlier: the failure was repaired, and re-sending it would be telling the
 * agent to fix something that is already fixed.
 */
export function latestFailedAttempt(
  entries: readonly FailedAttemptSource[],
  moduleId: string,
  processStartedAtIso: string
): PriorAttempt | null {
  const own = entries.filter((entry) => entry.moduleId === moduleId);
  const latest = own[own.length - 1];
  if (latest === undefined || latest.outcome !== "failure") return null;

  const record = latest.failure ?? reconstructLegacyRecord(latest.failureReason);

  return {
    record,
    filesWritten: latest.filesWritten,
    attemptNumber: failedAttemptCount(entries, moduleId),
    crossProcess: latest.finishedAt < processStartedAtIso,
    filesVanished: false,
  };
}

/** `apps/web/src/m01/db.ts(131,3): error TS2322: Type 'x' is not assignable...` */
const TSC_DIAGNOSTIC_LINE_RE = /error TS\d+:/;

/**
 * Rebuilds a ModuleFailureRecord from a pre-v3 ledger entry, which recorded the
 * prose `failureReason` and nothing else.
 *
 * This is string-sniffing, which is exactly what `failureKind` exists to avoid —
 * and it is confined to this function for that reason. It is worth doing anyway,
 * because the alternative for a ledger written before this change is a retry
 * prompt that says "something went wrong" while the tsc diagnostics sit right
 * there inside the sentence. There is one such ledger in the wild already: the
 * halted M01 run this whole change came out of.
 *
 * Safe to pattern-match because these are not arbitrary strings — every prefix
 * below is written by verifyModule/runModuleStage in this same repo. Anything
 * that matches nothing falls through to "sdk", whose remedy text makes no claim
 * about what specifically broke.
 *
 * One known limitation: the prose form truncates at five diagnostics with an
 * "...and N more" line, so a legacy typecheck record can recover only the five
 * that were shown. A v3 record keeps all of them.
 */
function reconstructLegacyRecord(failureReason: string | null): ModuleFailureRecord {
  const reason = failureReason ?? "the previous attempt was rejected, for an unrecorded reason";
  const base = { reason, typecheckErrors: [], stubFindings: [], unownedReqs: [] };

  if (/^tsc --noEmit reported/.test(reason)) {
    const lines = reason
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => TSC_DIAGNOSTIC_LINE_RE.test(line));
    // Only claim "typecheck" if the diagnostics actually survived; a summary
    // line with no diagnostics under it has nothing to send anyone after.
    if (lines.length > 0) return { ...base, kind: "typecheck", typecheckErrors: lines };
  }

  if (/^stub detection tripped/.test(reason)) return { ...base, kind: "stub" };

  if (/^claimed REQ IDs it does not own/.test(reason)) {
    const unowned = [...new Set([...reason.matchAll(/REQ-\d+/g)].map((match) => match[0]))];
    // The sentence names the module's OWNED reqs too, after the claimed ones, so
    // only the ids before the parenthetical are the unowned ones.
    const cut = reason.indexOf("(");
    const claimedPart = cut === -1 ? reason : reason.slice(0, cut);
    const onlyClaimed = unowned.filter((req) => claimedPart.includes(req));
    return { ...base, kind: "req-claim", unownedReqs: onlyClaimed.length > 0 ? onlyClaimed : unowned };
  }

  if (/^no files were created or modified/.test(reason)) return { ...base, kind: "no-files" };

  return { ...base, kind: "sdk" };
}

/** What went wrong, in the agent's own terms, per failure kind. */
function diagnosis(record: ModuleFailureRecord): string[] {
  switch (record.kind) {
    case "typecheck":
      return [
        `WHAT WENT WRONG: the orchestrator ran \`tsc --noEmit\` over the whole workspace after ` +
          `your last call and it reported ${record.typecheckErrors.length} genuine error(s) in the ` +
          `code you wrote.`,
        `Unresolved-import diagnostics (TS2307) are EXPECTED in this workspace — nothing is ` +
          `installed and you have no shell — and have already been filtered out. Every line below ` +
          `is a real defect and is yours to fix:`,
        fence(record.typecheckErrors),
      ];
    case "stub":
      return [
        `WHAT WENT WRONG: placeholder detection rejected your last call. ${record.reason}`,
        record.stubFindings.length > 0
          ? `The markers it found:\n\n${fence(record.stubFindings)}`
          : `No individual markers were recorded, only the volume judgement above.`,
      ];
    case "req-claim":
      return [
        `WHAT WENT WRONG: the PIPELINE-PROGRESS block at the end of your last call claimed ` +
          `requirement IDs this module does not own: ${record.unownedReqs.join(", ")}.`,
        `This is a reporting error, not necessarily a code error — the files you wrote may be ` +
          `fine. Verification stops at the first failure, so nothing after this check was even run.`,
      ];
    case "no-files":
      return [
        `WHAT WENT WRONG: your last call ended without creating or modifying a single file in the ` +
          `workspace. Whatever the reply said, nothing reached disk.`,
      ];
    case "sdk":
      return [
        `WHAT WENT WRONG: your last call did not complete successfully. ${record.reason}`,
      ];
  }
}

/** How to proceed, per failure kind. All variants say: repair, do not restart. */
function remedy(record: ModuleFailureRecord, files: readonly string[]): string[] {
  const hasFiles = files.length > 0;

  switch (record.kind) {
    case "typecheck":
      return [
        hasFiles
          ? `WHAT TO DO NOW: open each file named in the diagnostics above, go to the line given, ` +
            `and fix that error specifically. Do not delete the module and write it again — the ` +
            `rest of it passed every other check, and a rewrite costs the same as the first ` +
            `attempt did and risks breaking what already works.`
          : `WHAT TO DO NOW: write the module, and make sure the mistake in the diagnostics above ` +
            `is not in it this time. There is nothing left to edit, so this is a fresh ` +
            `implementation that has to avoid a known specific error.`,
        `Do not silence the errors with \`any\`, \`as unknown as\`, \`@ts-ignore\`, or by widening a ` +
          `type until it stops complaining. Fix the actual mismatch the compiler is describing.`,
      ];
    case "stub":
      return [
        hasFiles
          ? `WHAT TO DO NOW: replace the placeholder code with a real implementation of what the ` +
            `design says this module does. Deleting the marker word and leaving the body empty ` +
            `does not pass — the check also measures empty bodies and code volume.`
          : `WHAT TO DO NOW: write a real implementation of what the design says this module does. ` +
            `A marker word removed from an empty body does not pass — the check also measures ` +
            `empty bodies and code volume.`,
      ];
    case "req-claim":
      return [
        hasFiles
          ? `WHAT TO DO NOW: keep the code you wrote (read it first — it is still there), and emit ` +
            `a PIPELINE-PROGRESS block that claims ONLY the REQ IDs listed for this module below. ` +
            `If you genuinely implemented something outside this module's scope, remove that code ` +
            `instead of claiming it; another module owns it.`
          : `WHAT TO DO NOW: build the module, and emit a PIPELINE-PROGRESS block that claims ONLY ` +
            `the REQ IDs listed for this module below. Anything outside that scope belongs to ` +
            `another module and must not be claimed here.`,
      ];
    case "no-files":
      return [
        `WHAT TO DO NOW: actually write the files this time, using the Write tool, at paths under ` +
          `the workspace root. Describing the code in your reply does not count and reporting ` +
          `files you did not write fails the same check again.`,
      ];
    case "sdk":
      return [
        hasFiles
          ? `WHAT TO DO NOW: read the files listed below before writing anything — they are the ` +
            `partial output of that call and are still on disk. Continue from them rather than ` +
            `writing duplicates alongside them.`
          : `WHAT TO DO NOW: start the module again. Nothing usable was left behind.`,
      ];
  }
}

function fence(lines: readonly string[]): string {
  const shown = lines.slice(0, MAX_RENDERED_LINES);
  const more =
    lines.length > shown.length ? [`...and ${lines.length - shown.length} more of the same kind`] : [];
  return ["```", ...shown, ...more, "```"].join("\n");
}

/**
 * Renders the retry section for a module's prompt.
 *
 * Marked with a loud delimiter on purpose: it is the one part of an otherwise
 * identical prompt that changed, and it needs to survive being the fifth of
 * eleven paragraphs in a long instruction.
 */
export function renderRetryGuidance(moduleId: string, prior: PriorAttempt): string {
  // Says only where the attempt came from. Whether its files are still on disk
  // is the fileList paragraph's job — saying it here too produced a section that
  // promised files in one sentence and withdrew them two later.
  const provenance = prior.crossProcess
    ? [
        `That attempt ran in an EARLIER orchestrator process, which you have no memory of. The run ` +
          `was stopped after it failed and has been started again.`,
      ]
    : [];

  const fileList =
    prior.filesWritten.length > 0
      ? [
          `FILES THAT ATTEMPT ${prior.attemptNumber} WROTE OR MODIFIED (they exist right now; read ` +
            `them before you write anything):`,
          fence(prior.filesWritten),
        ]
      : prior.filesVanished
        ? [
            `The files that attempt ${prior.attemptNumber} wrote are NO LONGER in the workspace — ` +
              `they were removed between then and now. You are writing this module from scratch, ` +
              `so the guidance above is about a mistake to avoid rather than code to go and edit.`,
          ]
        : absentFilesParagraph(prior);

  return [
    `=== THIS IS A RETRY. REPAIR THE PREVIOUS ATTEMPT — DO NOT START OVER. ===`,
    `Attempt ${prior.attemptNumber} at ${moduleId} was rejected by the orchestrator's verification.`,
    ...provenance,
    ...diagnosis(prior.record),
    ...fileList,
    ...remedy(prior.record, prior.filesWritten),
    `Everything after this line is the same instruction you were given last time. The section ` +
      `above is the only new information, and it is the reason this call exists.`,
    `=== END RETRY CONTEXT ===`,
  ].join("\n\n");
}
