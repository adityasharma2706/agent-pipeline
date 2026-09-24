// The routing log: every feedback-router decision, written down as data.
//
// docs/okf.md §3.5 lists, among the implications to weigh, "Should routing
// decisions be logged as data, so their accuracy can be measured over time?"
// The answer this pipeline gives is yes, and this file is that answer. Each
// decision is appended to state/routing.jsonl with the evidence it rested on,
// the confidence the router claimed, the gate rule that judged it, and whether
// it was actually enacted.
//
// Two things make the log worth keeping rather than decorative:
//
//  - REJECTED decisions are logged too. docs/okf.md §3.1 puts the best general
//    method for agent-level failure attribution at ~53.5% and a purpose-trained
//    model at ~69%. Measuring that rate needs the whole sample, not just the
//    decisions that already passed the confidence filter.
//  - It is JSONL, appended, never rewritten. A log you can rewrite is a log
//    whose history you cannot trust.
//
// The location is state/, not docs/. docs/ is pipeline-owned: every file in it
// is a STAGE artifact with a declared writer and reader. A routing decision is
// orchestrator bookkeeping about the run, which is what state/ holds.
// (docs/lld.md §M28 puts the equivalent file at `.pipeline/routing.jsonl` —
// same separation, that design just names the directory differently.)

import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "./agent-loader.js";
import type { RoutingLogEntry } from "./types.js";

const ROUTING_LOG_PATH = path.join(PROJECT_ROOT, "state", "routing.jsonl");

/** Absolute path to the routing log, for console messages. */
export function routingLogPath(): string {
  return ROUTING_LOG_PATH;
}

function isRoutingLogEntry(value: unknown): value is RoutingLogEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Record<string, unknown>;
  return typeof entry.id === "string" && typeof entry.target_stage === "string";
}

/**
 * Reads the log. A corrupt LINE is skipped with a warning rather than taking
 * the run down: the log is an analysis artifact, and the only thing the
 * orchestrator needs from it at runtime is the highest `RD-n` allocated so
 * far. Losing one unreadable line degrades the analysis; throwing would halt a
 * run over a file nothing depends on.
 */
export async function loadRoutingLog(): Promise<RoutingLogEntry[]> {
  let raw: string;
  try {
    raw = await readFile(ROUTING_LOG_PATH, "utf-8");
  } catch {
    return [];
  }

  const entries: RoutingLogEntry[] = [];
  let skipped = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim().length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isRoutingLogEntry(parsed)) entries.push(parsed);
      else skipped += 1;
    } catch {
      skipped += 1;
    }
  }
  if (skipped > 0) {
    console.warn(`  warning: skipped ${skipped} unreadable line(s) in ${ROUTING_LOG_PATH}.`);
  }
  return entries;
}

/**
 * The next `RD-n`, derived as "the max existing id plus 1" exactly as
 * docs/lld.md §base specifies for the RD/I/S/C counters. Derived from the log
 * rather than stored in state/run.json on purpose: the counter and the records
 * it numbers then cannot drift apart.
 */
export function nextRoutingDecisionId(entries: RoutingLogEntry[]): string {
  let max = 0;
  for (const entry of entries) {
    const match = /^RD-(\d+)$/.exec(entry.id);
    if (match === null) continue;
    const n = Number(match[1]);
    if (Number.isInteger(n) && n > max) max = n;
  }
  return `RD-${max + 1}`;
}

/** Appends one decision. Append-only: a routing log you can edit proves nothing. */
export async function appendRoutingEntry(entry: RoutingLogEntry): Promise<void> {
  await appendFile(ROUTING_LOG_PATH, `${JSON.stringify(entry)}\n`, "utf-8");
}
