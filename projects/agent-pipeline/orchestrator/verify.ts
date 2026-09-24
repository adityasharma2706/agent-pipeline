// Orchestrator-side verification of one spec-implementer module.
//
// "The agent said it was done" is not evidence. Neither is "a file appeared":
// writing a file is trivially satisfiable, and the cheapest way for a model to
// satisfy it is a stub. So each module is judged on four orthogonal checks
// (files written, typecheck, stub density, REQ scope), all run by this process.

import type { ModuleSpec } from "./modules.js";
import { readWorkspaceFile } from "./workspace.js";
import type { TypecheckResult } from "./workspace.js";

/** Extensions treated as code for stub scanning and the code-volume floor. */
const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

/**
 * Markers that mean "this is not implemented" in so many words. One hit
 * anywhere fails the module: there is no density argument for a function that
 * announces it does nothing.
 */
const HARD_STUB_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "not implemented", re: /\bnot[ _-]?implemented\b/i },
  { label: "unimplemented", re: /\bunimplemented\b/i },
  { label: "not yet implemented", re: /\bnot yet implemented\b/i },
  { label: "placeholder implementation", re: /\bplaceholder\b/i },
  { label: "stub marker", re: /\bstub(bed)?\s+(out|for now|implementation)\b/i },
];

/**
 * Markers that are normal in small numbers and damning in bulk. Judged by
 * density (see STUB_DENSITY_LINES) rather than by presence.
 */
const SOFT_STUB_PATTERNS: ReadonlyArray<{ label: string; re: RegExp }> = [
  { label: "TODO", re: /\bTODO\b/ },
  { label: "FIXME", re: /\bFIXME\b/ },
  // `function f() {}`, `) {}`, `=> {}`, `): Promise<void> {}` — an empty body.
  // Deliberately also matches empty class/object literal bodies; over-matching
  // here only costs a soft point, and soft points need company to fail.
  { label: "empty body", re: /(\)|=>)\s*(:[^={};]+)?\s*\{\s*\}/ },
];

/** One soft marker per this many non-empty code lines is the failure line. */
const STUB_DENSITY_LINES = 40;

/** Fewer non-empty code lines than this across all code files is not an implementation. */
const MIN_CODE_LINES = 10;

export interface StubFinding {
  file: string;
  line: number;
  kind: "hard" | "soft";
  label: string;
  text: string;
}

export interface StubReport {
  isStub: boolean;
  reason: string | null;
  findings: StubFinding[];
  codeLines: number;
  codeFileCount: number;
}

function isCodeFile(file: string): boolean {
  const dot = file.lastIndexOf(".");
  return dot !== -1 && CODE_EXTENSIONS.has(file.slice(dot).toLowerCase());
}

/**
 * Decides whether the files a module wrote are substantially placeholder.
 *
 * What it catches, precisely:
 *  1. Any hard marker in any written file — the words "not implemented",
 *     "unimplemented", "not yet implemented", "placeholder", or a "stub
 *     out/for now/implementation" phrase. `throw new Error("unimplemented")`
 *     and `// TODO: not implemented yet` are both caught by this rule.
 *  2. Soft markers — `TODO`, `FIXME`, and empty `{}` bodies — at a density
 *     above one per 40 non-empty code lines.
 *  3. Fewer than 10 non-empty code lines in total, when any code file was
 *     written at all. (A module that legitimately writes only config/markdown
 *     is exempt from this rule but still subject to rules 1 and 2.)
 *
 * What it deliberately does NOT do: understand the code. It is a cheap text
 * heuristic whose job is to make the trivial failure mode expensive, not to
 * prove correctness — that is the typecheck's job, and the reviewer's after it.
 */
export async function detectStubs(files: string[]): Promise<StubReport> {
  const findings: StubFinding[] = [];
  let codeLines = 0;
  let codeFileCount = 0;

  for (const file of files) {
    const contents = await readWorkspaceFile(file);
    if (contents === null) continue;

    const code = isCodeFile(file);
    if (code) {
      codeFileCount += 1;
      codeLines += contents.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
    }

    const lines = contents.split(/\r?\n/);
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i] ?? "";
      for (const { label, re } of HARD_STUB_PATTERNS) {
        if (re.test(line)) {
          findings.push({ file, line: i + 1, kind: "hard", label, text: line.trim().slice(0, 160) });
        }
      }
      // Soft markers only count inside code files; prose in a README saying
      // "TODO" is not a stubbed implementation.
      if (!code) continue;
      for (const { label, re } of SOFT_STUB_PATTERNS) {
        if (re.test(line)) {
          findings.push({ file, line: i + 1, kind: "soft", label, text: line.trim().slice(0, 160) });
        }
      }
    }
  }

  const hard = findings.filter((f) => f.kind === "hard");
  if (hard.length > 0) {
    const first = hard[0];
    return {
      isStub: true,
      reason:
        `explicit "not implemented" marker (${hard.length} hit${hard.length === 1 ? "" : "s"}), ` +
        `first at ${first?.file}:${first?.line} — "${first?.label}"`,
      findings,
      codeLines,
      codeFileCount,
    };
  }

  if (codeFileCount > 0 && codeLines < MIN_CODE_LINES) {
    return {
      isStub: true,
      reason: `only ${codeLines} non-empty code lines written across ${codeFileCount} code file(s); minimum is ${MIN_CODE_LINES}`,
      findings,
      codeLines,
      codeFileCount,
    };
  }

  const soft = findings.filter((f) => f.kind === "soft");
  if (soft.length > 0 && soft.length * STUB_DENSITY_LINES > codeLines) {
    return {
      isStub: true,
      reason:
        `${soft.length} placeholder marker(s) (TODO/FIXME/empty body) across ${codeLines} ` +
        `non-empty code lines — above the 1-per-${STUB_DENSITY_LINES} threshold`,
      findings,
      codeLines,
      codeFileCount,
    };
  }

  return { isStub: false, reason: null, findings, codeLines, codeFileCount };
}

/**
 * The block the prompt asks the agent to end its reply with:
 *
 *   PIPELINE-PROGRESS
 *   module: M07
 *   files: src/a.ts, src/b.ts
 *   reqs: REQ-012, REQ-013
 *   deviations: none
 *   END-PIPELINE-PROGRESS
 */
export interface ReportedProgress {
  found: boolean;
  moduleId: string | null;
  files: string[];
  reqs: string[];
  deviations: string | null;
}

const PROGRESS_BLOCK_RE = /PIPELINE-PROGRESS\s*\n([\s\S]*?)\n\s*END-PIPELINE-PROGRESS/;

function fieldOf(block: string, key: string): string | null {
  const re = new RegExp(`^\\s*${key}\\s*:\\s*(.*)$`, "im");
  const match = re.exec(block);
  const value = match?.[1]?.trim();
  return value === undefined || value.length === 0 ? null : value;
}

/**
 * Parses the agent's self-report. This is INPUT to verification, never proof of
 * it: `files` and `reqs` here are claims, checked against what the orchestrator
 * observed on disk and against docs/implementer.md respectively.
 */
export function parseReportedProgress(text: string): ReportedProgress {
  const match = PROGRESS_BLOCK_RE.exec(text);
  if (match === null) {
    return { found: false, moduleId: null, files: [], reqs: [], deviations: null };
  }
  const block = match[1] ?? "";
  const filesRaw = fieldOf(block, "files");
  const reqsRaw = fieldOf(block, "reqs") ?? "";
  const deviations = fieldOf(block, "deviations");

  const reqs = [...new Set([...reqsRaw.matchAll(/REQ-\d+/g)].map((m) => m[0]))];
  const files =
    filesRaw === null
      ? []
      : filesRaw
          .split(",")
          .map((f) => f.trim())
          .filter((f) => f.length > 0);

  return {
    found: true,
    moduleId: fieldOf(block, "module"),
    files,
    reqs,
    deviations: deviations === null || /^(none|n\/?a|-)$/i.test(deviations) ? null : deviations,
  };
}

/** REQ IDs the agent claimed that docs/implementer.md does not assign this module. */
export function unownedReqClaims(spec: ModuleSpec, claimed: string[]): string[] {
  const owned = new Set(spec.reqs);
  return claimed.filter((req) => !owned.has(req));
}

export interface ModuleVerification {
  ok: boolean;
  /** Human-readable reason for failure; null when ok. */
  failureReason: string | null;
  /** Non-fatal observations worth recording (missing deps, absent report). */
  warnings: string[];
  filesWritten: string[];
  reqsClaimed: string[];
  stub: StubReport;
  typecheck: TypecheckResult;
}

/**
 * Applies the four checks in cheapest-first order and stops at the first
 * failure, so the recorded reason is the actual one rather than a pile.
 */
export async function verifyModule(
  spec: ModuleSpec,
  filesWritten: string[],
  reported: ReportedProgress,
  typecheck: TypecheckResult
): Promise<ModuleVerification> {
  const warnings: string[] = [];
  if (!reported.found) {
    warnings.push(
      "agent did not emit a PIPELINE-PROGRESS block, so its REQ claims and deviation notes are unknown"
    );
  }
  for (const warning of typecheck.missingModuleWarnings) {
    warnings.push(`unresolved import (expected — nothing is installed): ${warning}`);
  }

  const empty: StubReport = {
    isStub: false,
    reason: null,
    findings: [],
    codeLines: 0,
    codeFileCount: 0,
  };
  const base = {
    warnings,
    filesWritten,
    reqsClaimed: reported.reqs,
    typecheck,
  };

  // 1. Did anything actually get written?
  if (filesWritten.length === 0) {
    return {
      ...base,
      ok: false,
      failureReason: "no files were created or modified in the workspace during this call",
      stub: empty,
    };
  }

  // 2. Are the REQ claims inside the module's assigned scope?
  const unowned = unownedReqClaims(spec, reported.reqs);
  if (unowned.length > 0) {
    return {
      ...base,
      ok: false,
      stub: empty,
      failureReason:
        `claimed REQ IDs it does not own: ${unowned.join(", ")} ` +
        `(docs/implementer.md assigns ${spec.id}: ${spec.reqs.join(", ") || "none"})`,
    };
  }

  // 3. Is what it wrote substantially placeholder?
  const stub = await detectStubs(filesWritten);
  if (stub.isStub) {
    return { ...base, ok: false, stub, failureReason: `stub detection tripped — ${stub.reason}` };
  }

  // 4. Does the whole workspace still typecheck?
  if (typecheck.errors.length > 0) {
    const shown = typecheck.errors.slice(0, 5).join("\n      ");
    const more = typecheck.errors.length > 5 ? `\n      ...and ${typecheck.errors.length - 5} more` : "";
    return {
      ...base,
      stub,
      ok: false,
      failureReason: `tsc --noEmit reported ${typecheck.errors.length} error(s):\n      ${shown}${more}`,
    };
  }

  return { ...base, ok: true, failureReason: null, stub };
}
