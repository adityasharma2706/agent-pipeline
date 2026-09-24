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

export interface ProgressLog {
  /** Schema marker so a later phase can migrate this file knowingly. */
  version: 1;
  updatedAt: string;
  entries: ModuleProgressEntry[];
}

function emptyLog(): ProgressLog {
  return { version: 1, updatedAt: new Date().toISOString(), entries: [] };
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
    return emptyLog();
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

  const candidate = parsed as { entries?: unknown };
  if (!Array.isArray(candidate.entries) || !candidate.entries.every(isEntry)) {
    throw new Error(`${file} does not match the expected progress-log shape. Fix or delete it.`);
  }
  return { version: 1, updatedAt: new Date().toISOString(), entries: candidate.entries };
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
    version: 1,
    updatedAt: new Date().toISOString(),
    entries: [...log.entries, entry],
  };
  const root = workspaceRoot();
  await writeFile(path.join(root, PROGRESS_JSON), `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  await writeFile(path.join(root, PROGRESS_MD), renderMarkdown(next), "utf-8");
  return next;
}
