// The per-module progress log.
//
// It lives in the WORKSPACE, not in docs/. docs/ is pipeline-owned — every file
// in it is a stage artifact with a declared writer and reader. The progress log
// is product-owned: it describes the generated codebase, travels with it, and
// belongs in its git history rather than this repo's.
//
// It is also the resume ledger: a module recorded here as "success" is skipped
// on the next run, which is what makes `--max-modules` a resumable cap rather
// than a truncation.

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { InheritedDiagnostic } from "./baseline.js";
import type { ModuleFailureRecord } from "./retry-context.js";
import { describeInheritedOwners } from "./baseline.js";
import { PROGRESS_JSON, PROGRESS_MD, workspaceRoot } from "./workspace.js";

export interface ModuleProgressEntry {
  moduleId: string;
  title: string;
  startedAt: string;
  finishedAt: string;
  outcome: "success" | "failure";
  /** Workspace-relative paths the orchestrator observed change during the call. */
  filesWritten: string[];
  /** REQ IDs the agent claimed, already checked against docs/implementer.md. */
  reqsClaimed: string[];
  /** Populated on failure: why the orchestrator rejected the module. */
  failureReason: string | null;
  /**
   * Populated on failure: the STRUCTURED form of the same rejection, which is
   * what the next attempt's prompt is built from (orchestrator/retry-context.ts).
   *
   * It lives in the ledger rather than in orchestrator memory because the
   * failing files live in the workspace, and the two have to survive together.
   * A run stopped after a failure and re-run later would otherwise give its
   * "first" attempt an identical prompt and re-roll blind against files it does
   * not know it wrote — exactly the bug the in-process feedback fixes.
   *
   * Optional: absent on every success, and absent on failures recorded by a
   * build before the field existed (v2 ledgers), which readers degrade
   * gracefully for rather than rejecting.
   */
  failure?: ModuleFailureRecord;
  /**
   * Typecheck diagnostics that were present BEFORE this module ran (or that a
   * dependency install revealed during its attempt) in files it never touched.
   *
   * They did not fail it, and they must not: they belong to whichever earlier
   * module wrote the file, named here in `owner` where the ledger can identify
   * it. They are recorded rather than merely logged so they are durable —
   * somebody has to decide to fix them, and the reviewer stage reads this file.
   *
   * Optional and absent when there were none, and on every entry written before
   * the field existed.
   */
  inheritedDiagnostics?: InheritedDiagnostic[];
  /** Deviation notes the agent reported, verbatim. */
  deviations: string | null;
  /** Non-fatal observations (unresolved imports, missing self-report). */
  warnings: string[];
  costUsd: number;
  numTurns: number;
}

/**
 * One on-demand repair session (orchestrator/repair.ts, invokeRepairer).
 *
 * WHY THIS IS A SIBLING ARRAY AND NOT AN `entries[]` ENTRY
 * -------------------------------------------------------
 * `entries[]` is the MODULE ledger, and two things derive from it that a repair
 * would corrupt:
 *
 *   - `fileOwners()` (baseline.ts) reads `entries[].filesWritten` and gives the
 *     file to the LAST writer. A repair recorded there would become the owner of
 *     every file it edited, so every future diagnostic in M04's code would be
 *     attributed to the repairer instead of to M04 — destroying the exact
 *     attribution that made this problem diagnosable and that the repairer
 *     exists because of.
 *   - `completedModuleIds()` reads `entries[].outcome`, and that set is what a
 *     re-run skips. A repair is not a module attempt and must never be able to
 *     mark a module built, or to make one look unbuilt.
 *
 * So repairs live in `repairs[]`: same file, because a repair is a fact about
 * this workspace's code and has to travel with it, and because the reviewer
 * stage already reads this file. Separate array, because it is a different kind
 * of event and the module ledger's readers must not see it at all.
 */
export interface RepairRecord {
  /** `R-1`, monotonic within this ledger — the scheme C-n/F-n/RD-n use. */
  repairId: string;
  startedAt: string;
  finishedAt: string;
  /** The module whose diagnostics were targeted, or null for "all outstanding". */
  targetModuleId: string | null;
  /** The tsc lines it was asked to fix, verbatim, as they read before the repair. */
  targeted: string[];
  /** Owner breakdown of `targeted`, e.g. "M04 x6, M01 x1". */
  targetOwners: string;
  /** Workspace-relative paths observed to change during the call. */
  filesChanged: string[];
  /**
   * `accepted`   - every target fixed, nothing new anywhere; the edits are kept.
   * `rolled-back`- verification failed or the call failed; workspace restored.
   * `declined`   - nothing ran and nothing was spent (no git, nothing to fix).
   */
  outcome: "accepted" | "rolled-back" | "declined";
  /** One line saying why the outcome is what it is. */
  reason: string;
  /** Targeted diagnostics still present afterwards. Empty on acceptance. */
  remaining: string[];
  /** Diagnostics that did not exist before this repair. Empty on acceptance. */
  regressions: string[];
  /** The commit the workspace was snapshotted to, and reset to if rejected. */
  snapshotCommit: string | null;
  costUsd: number;
  numTurns: number;
}

/**
 * Which product a ledger's entries were built from.
 *
 * Module ids are POSITIONAL — every product's docs/implementer.md starts at
 * M01 — so an entry keyed only by "M01" says nothing about which plan it came
 * from. Without this, pointing a different idea at an existing workspace makes
 * spec-implementer read M01-M04 as "already complete" and skip them, shipping
 * one product's code as another product's first four modules. The plan hash is
 * the identity that makes that impossible to do silently.
 */
export interface LedgerIdentity {
  /** sha256 of the normalised docs/implementer.md the modules come from. */
  planHash: string;
  /** sha256 of the normalised docs/idea.md, when there is one. Advisory. */
  ideaHash: string | null;
}

export interface ProgressLog {
  /**
   * Schema marker so a later phase can migrate this file knowingly.
   *
   * 3 added `entries[].failure`. 4 added `repairs[]`. Both bumps are additive —
   * a v2 or v3 ledger loads unchanged and simply carries no structured failure
   * and no repairs — so no migration is needed and none is performed.
   */
  version: 4;
  updatedAt: string;
  /**
   * Provenance of `entries`. Null only for a ledger written before the field
   * existed, which is treated as UNKNOWN provenance and refused, never as a
   * match — assuming a match is exactly the silent reuse this prevents.
   */
  planHash: string | null;
  ideaHash: string | null;
  entries: ModuleProgressEntry[];
  /**
   * On-demand repair sessions. Absent in a v3 ledger and normalised to `[]` on
   * load, so every reader can treat it as a list without checking.
   */
  repairs: RepairRecord[];
}

/** Normalises away whitespace-only differences before hashing. */
function normaliseForHash(text: string): string {
  return text
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

/** sha256 of a document's meaningful content, or null for absent content. */
export function hashDocument(text: string | null): string | null {
  if (text === null) return null;
  const normalised = normaliseForHash(text);
  if (normalised.length === 0) return null;
  return createHash("sha256").update(normalised, "utf-8").digest("hex").slice(0, 32);
}

function emptyLog(identity: LedgerIdentity | null): ProgressLog {
  return {
    version: 4,
    updatedAt: new Date().toISOString(),
    planHash: identity?.planHash ?? null,
    ideaHash: identity?.ideaHash ?? null,
    entries: [],
    repairs: [],
  };
}

const FAILURE_KINDS: ReadonlySet<string> = new Set([
  "no-files",
  "req-claim",
  "stub",
  "typecheck",
  "sdk",
]);

/** Every string array in a ModuleFailureRecord, checked the same way. */
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/**
 * Validates `entries[].failure` when it is present.
 *
 * A malformed record is REJECTED rather than repaired: it is fed verbatim into a
 * prompt that costs real money, and half-parsed diagnostics would send the next
 * attempt after an error that was never reported.
 */
function isFailureRecord(value: unknown): value is ModuleFailureRecord {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.kind === "string" &&
    FAILURE_KINDS.has(record.kind) &&
    typeof record.reason === "string" &&
    isStringArray(record.typecheckErrors) &&
    isStringArray(record.stubFindings) &&
    isStringArray(record.unownedReqs)
  );
}

/**
 * Validates `entries[].inheritedDiagnostics` when present.
 *
 * Rejected rather than repaired, like `failure`: these lines are the pipeline's
 * only durable record that a real bug exists and belongs to somebody, and a
 * half-parsed one is a bug that quietly stops being reported.
 */
function isInheritedDiagnostic(value: unknown): value is InheritedDiagnostic {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.diagnostic === "string" &&
    typeof item.file === "string" &&
    typeof item.code === "string" &&
    (item.reason === "pre-existing" ||
      item.reason === "revealed-by-install" ||
      item.reason === "revealed-by-config") &&
    (item.owner === null || typeof item.owner === "string")
  );
}

const REPAIR_OUTCOMES: ReadonlySet<string> = new Set(["accepted", "rolled-back", "declined"]);

/**
 * Validates `repairs[]` when present.
 *
 * Rejected rather than repaired, like the other two. This array is the only
 * durable record that an agent was permitted to edit another module's files and
 * what came of it; a half-parsed entry is an audit trail that quietly stops
 * being one.
 */
function isRepairRecord(value: unknown): value is RepairRecord {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.repairId === "string" &&
    (item.targetModuleId === null || typeof item.targetModuleId === "string") &&
    isStringArray(item.targeted) &&
    isStringArray(item.filesChanged) &&
    isStringArray(item.remaining) &&
    isStringArray(item.regressions) &&
    typeof item.outcome === "string" &&
    REPAIR_OUTCOMES.has(item.outcome) &&
    typeof item.reason === "string" &&
    (item.snapshotCommit === null || typeof item.snapshotCommit === "string")
  );
}

function isEntry(value: unknown): value is ModuleProgressEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.moduleId === "string" &&
    (entry.outcome === "success" || entry.outcome === "failure") &&
    Array.isArray(entry.filesWritten) &&
    (entry.failure === undefined || isFailureRecord(entry.failure)) &&
    (entry.inheritedDiagnostics === undefined ||
      (Array.isArray(entry.inheritedDiagnostics) &&
        entry.inheritedDiagnostics.every(isInheritedDiagnostic)))
  );
}

/**
 * Loads the log, tolerating absence (first run) but not silently tolerating
 * corruption: an unreadable log would make every completed module look
 * incomplete and re-run it, which costs real money.
 */
export async function loadProgress(): Promise<ProgressLog> {
  const file = path.join(workspaceRoot(), PROGRESS_JSON);
  let raw: string;
  try {
    raw = await readFile(file, "utf-8");
  } catch {
    return emptyLog(null);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `${file} is not valid JSON. It is the resume ledger for spec-implementer; fix or delete it ` +
        `before re-running (deleting it means already-built modules will be built again).`
    );
  }

  const candidate = parsed as {
    entries?: unknown;
    planHash?: unknown;
    ideaHash?: unknown;
    repairs?: unknown;
  };
  if (!Array.isArray(candidate.entries) || !candidate.entries.every(isEntry)) {
    throw new Error(`${file} does not match the expected progress-log shape. Fix or delete it.`);
  }
  // Absent in a v3 ledger, which is the normal case for any workspace built
  // before the repairer existed: that is "no repairs have been run", not a
  // corrupt file, so it normalises to [] rather than being refused.
  if (candidate.repairs !== undefined) {
    if (!Array.isArray(candidate.repairs) || !candidate.repairs.every(isRepairRecord)) {
      throw new Error(
        `${file} has a "repairs" array that does not match the expected shape. Fix or delete it.`
      );
    }
  }
  return {
    version: 4,
    updatedAt: new Date().toISOString(),
    planHash: typeof candidate.planHash === "string" ? candidate.planHash : null,
    ideaHash: typeof candidate.ideaHash === "string" ? candidate.ideaHash : null,
    entries: candidate.entries,
    repairs: Array.isArray(candidate.repairs) ? (candidate.repairs as RepairRecord[]) : [],
  };
}

/** The outcome of checking a loaded ledger against the plan about to be built. */
export type LedgerCheck =
  | { ok: true; log: ProgressLog }
  | { ok: false; reason: "unknown-provenance" | "different-plan"; message: string };

/**
 * Refuses to reuse a ledger that was not built from THIS plan.
 *
 * An empty ledger is adopted rather than refused: it records nothing, so there
 * is nothing to reuse wrongly, and refusing it would make a freshly-created
 * workspace unusable. Anything with entries must prove where it came from.
 *
 * The workspace is never touched here. Deleting somebody's generated code to
 * resolve a mismatch is not a decision this process gets to make.
 */
export function checkLedgerProvenance(log: ProgressLog, identity: LedgerIdentity): LedgerCheck {
  const file = path.join(workspaceRoot(), PROGRESS_JSON);

  if (log.entries.length === 0) {
    return { ok: true, log: { ...log, planHash: identity.planHash, ideaHash: identity.ideaHash } };
  }

  if (log.planHash === identity.planHash) return { ok: true, log };

  const known = log.planHash !== null;
  const reason = known ? "different-plan" : "unknown-provenance";
  const completed = log.entries.filter((e) => e.outcome === "success").map((e) => e.moduleId);
  const detail = known
    ? `it was built from a DIFFERENT docs/implementer.md (ledger plan ${log.planHash}, ` +
      `current plan ${identity.planHash}).`
    : "it records no plan hash at all, so which product it belongs to is UNKNOWN. " +
      "It is not assumed to match: that assumption is the failure this check exists to prevent.";

  const message = [
    `Refusing to reuse the progress ledger at ${file}:`,
    `  ${detail}`,
    `  It reports these modules complete: ${completed.join(", ") || "(none)"}.`,
    "",
    "Module ids are positional — every product's plan starts at M01 — so reusing this ledger",
    "would mark modules of the CURRENT plan complete using another product's code. Nothing has",
    "been spent and nothing has been changed.",
    "",
    "To proceed, either build into a fresh workspace:",
    "",
    "  PIPELINE_WORKSPACE=~/agent-pipeline-workspace-2 npm run orchestrator",
    "",
    `...or, if the old workspace is genuinely finished with, move or remove it yourself`,
    `(this process will not delete it):`,
    "",
    `  mv ${workspaceRoot()} ${workspaceRoot()}-old`,
  ].join("\n");

  return { ok: false, reason, message };
}

/** Module IDs that completed successfully — the set a re-run skips. */
export function completedModuleIds(log: ProgressLog): Set<string> {
  return new Set(log.entries.filter((entry) => entry.outcome === "success").map((e) => e.moduleId));
}

function renderMarkdown(log: ProgressLog): string {
  const lines: string[] = [
    "# Implementation progress",
    "",
    "Written by the agent-pipeline orchestrator (spec-implementer stage), one entry per",
    `module attempt. Generated from \`${PROGRESS_JSON}\` — edit that, not this.`,
    "",
    `Last updated: ${log.updatedAt}`,
    `Plan (docs/implementer.md) hash: ${log.planHash ?? "(unknown)"}`,
    `Idea (docs/idea.md) hash: ${log.ideaHash ?? "(unknown)"}`,
    "",
  ];

  for (const entry of log.entries) {
    lines.push(`## ${entry.moduleId} ${entry.title} — ${entry.outcome}`);
    lines.push("");
    lines.push(`- Ran: ${entry.startedAt} to ${entry.finishedAt}`);
    lines.push(`- Cost: $${entry.costUsd.toFixed(4)} over ${entry.numTurns} turns`);
    lines.push(
      `- Files written: ${entry.filesWritten.length > 0 ? entry.filesWritten.join(", ") : "(none)"}`
    );
    lines.push(`- REQs claimed: ${entry.reqsClaimed.length > 0 ? entry.reqsClaimed.join(", ") : "(none)"}`);
    if (entry.failureReason !== null) lines.push(`- Failed because: ${entry.failureReason}`);
    if (entry.failure !== undefined) {
      lines.push(`- Failure kind: ${entry.failure.kind} (fed back into the next attempt's prompt)`);
    }
    const inherited = entry.inheritedDiagnostics ?? [];
    if (inherited.length > 0) {
      lines.push(
        `- Inherited ${inherited.length} pre-existing typecheck error(s) — NOT this module's fault, ` +
          `not counted against it: ${describeInheritedOwners(inherited)}`
      );
      for (const item of inherited) {
        lines.push(`  - [${item.reason}, owner ${item.owner ?? "unattributed"}] ${item.diagnostic}`);
      }
    }
    if (entry.deviations !== null) lines.push(`- Deviations reported: ${entry.deviations}`);
    for (const warning of entry.warnings) lines.push(`- Warning: ${warning}`);
    lines.push("");
  }

  if (log.repairs.length > 0) {
    lines.push("# Repairs (on demand)");
    lines.push("");
    lines.push(
      "Each entry is one `--repair` invocation: an agent permitted to edit files another",
      "module wrote, in order to fix diagnostics no module owns. A repair is kept only if",
      "every targeted diagnostic went away AND no new one appeared anywhere; otherwise the",
      "workspace was reset to the commit named below and nothing was kept."
    );
    lines.push("");
    for (const repair of log.repairs) {
      lines.push(
        `## ${repair.repairId} ${repair.targetModuleId ?? "all outstanding"} — ${repair.outcome}`
      );
      lines.push("");
      lines.push(`- Ran: ${repair.startedAt} to ${repair.finishedAt}`);
      lines.push(`- Cost: $${repair.costUsd.toFixed(4)} over ${repair.numTurns} turns`);
      lines.push(`- Outcome: ${repair.outcome} — ${repair.reason}`);
      lines.push(`- Snapshot commit: ${repair.snapshotCommit ?? "(none taken)"}`);
      lines.push(`- Targeted ${repair.targeted.length} diagnostic(s) [${repair.targetOwners}]:`);
      for (const line of repair.targeted) lines.push(`  - ${line}`);
      lines.push(
        `- Files changed: ${repair.filesChanged.length > 0 ? repair.filesChanged.join(", ") : "(none)"}`
      );
      if (repair.remaining.length > 0) {
        lines.push(`- Still unfixed after the attempt:`);
        for (const line of repair.remaining) lines.push(`  - ${line}`);
      }
      if (repair.regressions.length > 0) {
        lines.push(`- NEW diagnostics the attempt introduced (why it was rejected):`);
        for (const line of repair.regressions) lines.push(`  - ${line}`);
      }
      lines.push("");
    }
  }

  return `${lines.join("\n")}\n`;
}

/** The next `R-n` id for this ledger. Monotonic, never reused. */
export function nextRepairId(log: ProgressLog): string {
  let max = 0;
  for (const repair of log.repairs) {
    const match = /^R-(\d+)$/.exec(repair.repairId);
    const n = match === null ? 0 : Number(match[1]);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `R-${max + 1}`;
}

/**
 * Appends one repair session and rewrites both files.
 *
 * Declined and rolled-back sessions are appended exactly like accepted ones. A
 * repair that was rejected is the more interesting record of the two: it says
 * an agent was pointed at these errors, tried, and could not fix them without
 * breaking something — which is precisely what a human needs to know before
 * paying for a second attempt at the same thing.
 *
 * Note for callers that roll back: call this AFTER the git restore. A restore
 * resets tracked files, and this file is tracked, so writing the record first
 * would erase it.
 */
export async function appendRepair(log: ProgressLog, repair: RepairRecord): Promise<ProgressLog> {
  const next: ProgressLog = {
    version: 4,
    updatedAt: new Date().toISOString(),
    planHash: log.planHash,
    ideaHash: log.ideaHash,
    entries: log.entries,
    repairs: [...log.repairs, repair],
  };
  const root = workspaceRoot();
  await writeFile(path.join(root, PROGRESS_JSON), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  await writeFile(path.join(root, PROGRESS_MD), renderMarkdown(next), "utf-8");
  return next;
}

/**
 * Appends one attempt and rewrites both files. Failures are appended too — a
 * module that failed honestly and said why is more useful than one that quietly
 * stubbed, and the reason has to survive the process exiting.
 */
export async function appendProgress(
  log: ProgressLog,
  entry: ModuleProgressEntry
): Promise<ProgressLog> {
  const next: ProgressLog = {
    version: 4,
    updatedAt: new Date().toISOString(),
    planHash: log.planHash,
    ideaHash: log.ideaHash,
    entries: [...log.entries, entry],
    repairs: log.repairs,
  };
  const root = workspaceRoot();
  await writeFile(path.join(root, PROGRESS_JSON), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  await writeFile(path.join(root, PROGRESS_MD), renderMarkdown(next), "utf-8");
  return next;
}
