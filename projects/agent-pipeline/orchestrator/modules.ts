// Parses the module breakdown out of docs/implementer.md.
//
// spec-implementer is the first stage that does not produce one document: it
// loops over the modules implementation-planning defined. That list is data in
// a markdown file, so it gets parsed rather than hardcoded — the current
// artifact happens to hold M01..M36, but a different idea produces a different
// count and the loop must follow whatever is actually on disk.

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PROJECT_ROOT } from "./agent-loader.js";

/** One `### Mnn Title` section of docs/implementer.md. */
export interface ModuleSpec {
  /** Canonical module ID, e.g. "M07". */
  id: string;
  /** Heading text after the ID, e.g. "Stage Registry & Mode Profiles". */
  title: string;
  /** The section body (prose + the Depends on / REQs bullets), trimmed. */
  body: string;
  /** Module IDs named on the `**Depends on:**` line; empty for "none". */
  dependsOn: string[];
  /** REQ IDs named on the `**REQs:**` line — the module's assigned scope. */
  reqs: string[];
}

/** `### M07 Stage Registry & Mode Profiles` */
const MODULE_HEADING_RE = /^###\s+(M\d+)\s*(.*)$/;

/** Any other markdown heading ends the current module's body. */
const ANY_HEADING_RE = /^#{1,6}\s/;

const DEPENDS_LINE_RE = /^\s*[-*]?\s*\*\*Depends on:\*\*\s*(.*)$/i;
const REQS_LINE_RE = /^\s*[-*]?\s*\*\*REQs:\*\*\s*(.*)$/i;

/** Pulls every `Mnn` / `REQ-nnn` token out of one line, de-duplicated, in order. */
function extractIds(line: string, pattern: RegExp): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const match of line.matchAll(pattern)) {
    const id = match[0];
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * Splits implementer markdown into ModuleSpecs, preserving document order.
 *
 * Document order is load-bearing: implementation-planning writes the modules in
 * dependency order (its "build order" is the point of the document), so running
 * them top to bottom already respects `Depends on:` without a topological sort.
 * `dependsOn` is parsed anyway so a later phase can check that claim instead of
 * trusting it.
 */
export function parseModules(markdown: string): ModuleSpec[] {
  const lines = markdown.split(/\r?\n/);
  const modules: ModuleSpec[] = [];

  let current: { id: string; title: string; bodyLines: string[] } | null = null;

  const flush = (): void => {
    if (current === null) return;
    const body = current.bodyLines.join("\n").trim();
    let dependsOn: string[] = [];
    let reqs: string[] = [];
    for (const line of current.bodyLines) {
      const depends = DEPENDS_LINE_RE.exec(line);
      if (depends !== null) dependsOn = extractIds(depends[1] ?? "", /M\d+/g);
      const reqLine = REQS_LINE_RE.exec(line);
      if (reqLine !== null) reqs = extractIds(reqLine[1] ?? "", /REQ-\d+/g);
    }
    modules.push({ id: current.id, title: current.title, body, dependsOn, reqs });
    current = null;
  };

  for (const line of lines) {
    const heading = MODULE_HEADING_RE.exec(line);
    if (heading !== null) {
      flush();
      current = {
        id: heading[1] ?? "",
        title: (heading[2] ?? "").trim(),
        bodyLines: [line],
      };
      continue;
    }
    if (current !== null && ANY_HEADING_RE.test(line)) {
      // A "## Phase 2: ..." group heading (or anything else) closes the module.
      flush();
      continue;
    }
    if (current !== null) current.bodyLines.push(line);
  }
  flush();

  return modules;
}

/** Reads and parses docs/implementer.md, failing loudly if it has no modules. */
export async function loadModules(implementerDocRelPath: string): Promise<ModuleSpec[]> {
  const fullPath = path.join(PROJECT_ROOT, implementerDocRelPath);
  let raw: string;
  try {
    raw = await readFile(fullPath, "utf-8");
  } catch {
    throw new Error(
      `Cannot read ${implementerDocRelPath} at ${fullPath} — spec-implementer has no module list ` +
        `to loop over. Run the implementation-planning stage first.`
    );
  }

  const modules = parseModules(raw);
  if (modules.length === 0) {
    throw new Error(
      `${implementerDocRelPath} contains no "### Mnn Title" module headings, so there is nothing ` +
        `for spec-implementer to build. This is a malformed upstream artifact, not a retryable failure.`
    );
  }
  return modules;
}
