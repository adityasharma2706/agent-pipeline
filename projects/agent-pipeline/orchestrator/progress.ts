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
  /** Schema marker so a later phase can migrate this file knowingly. */
  version: 2;
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
    version: 2,
    updatedAt: new Date().toISOString(),
    planHash: identity?.planHash ?? null,
    ideaHash: identity?.ideaHash ?? null,
    entries: [],
  };
}

function isEntry(value: unknown): value is ModuleProgressEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.moduleId === "string" &&
    (entry.outcome === "success" || entry.outcome === "failure") &&
    Array.isArray(entry.filesWritten)
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
    version: 2,
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
    version: 2,
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
