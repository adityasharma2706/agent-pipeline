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
   * 3 added `entries[].failure`. The bump is additive — v2 entries load
   * unchanged and simply carry no structured failure — so no migration is
   * needed and none is performed.
   */
  version: 3;
  updatedAt: string;
  /**
   * Provenance of `entries`. Null only for a ledger written before the field
   * existed, which is treated as UNKNOWN provenance and refused, never as a
   * match — assuming a match is exactly the silent reuse this prevents.
   */
  planHash: string | null;
  ideaHash: string | null;
  entries: ModuleProgressEntry[];
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
    version: 3,
    updatedAt: new Date().toISOString(),
    planHash: identity?.planHash ?? null,
    ideaHash: identity?.ideaHash ?? null,
    entries: [],
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
    (item.reason === "pre-existing" || item.reason === "revealed-by-install") &&
    (item.owner === null || typeof item.owner === "string")
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

  const candidate = parsed as { entries?: unknown; planHash?: unknown; ideaHash?: unknown };
  if (!Array.isArray(candidate.entries) || !candidate.entries.every(isEntry)) {
    throw new Error(`${file} does not match the expected progress-log shape. Fix or delete it.`);
  }
  return {
    version: 3,
    updatedAt: new Date().toISOString(),
    planHash: typeof candidate.planHash === "string" ? candidate.planHash : null,
    ideaHash: typeof candidate.ideaHash === "string" ? candidate.ideaHash : null,
    entries: candidate.entries,
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

  return `${lines.join("\n")}\n`;
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
    version: 3,
    updatedAt: new Date().toISOString(),
    planHash: log.planHash,
    ideaHash: log.ideaHash,
    entries: [...log.entries, entry],
  };
  const root = workspaceRoot();
  await writeFile(path.join(root, PROGRESS_JSON), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  await writeFile(path.join(root, PROGRESS_MD), renderMarkdown(next), "utf-8");
  return next;
}
