// The on-demand repairer: choosing what to fix, and deciding whether it was fixed.
//
// WHY A REPAIRER EXISTS AT ALL
// ----------------------------
// orchestrator/baseline.ts stops the module that happens to be building from
// being failed for errors in some earlier module's files. That is correct, and
// it has a consequence nobody chose: a diagnostic ruled "inherited" fails
// nobody, so nobody is ever asked to fix it. On a live 53-module build, seven
// errors in files written by M01 and M04 were inherited by every module after
// them. No module-scoped builder is permitted to touch another module's files,
// and the `reviewer` stage that could act on them only runs after all 53
// modules are built — roughly $121 away. A cross-module error had no owner.
//
// WHY IT IS AN AUXILIARY AGENT AND NOT A PIPELINE STAGE
// -----------------------------------------------------
// This is evidential, not stylistic. The pipeline's own research file
// (docs/okf.md §4) records that adding roles to a multi-agent pipeline is not
// free and is frequently negative: a five-role pipeline measured LOWER accuracy
// than a simpler arrangement (75% -> 45%), a two-agent team beat a three-agent
// waterfall, and roughly 37% of observed multi-agent failures come from
// inter-agent misalignment rather than from any single agent being bad at its
// job. Every role added to PIPELINE_STAGES is another handoff that can
// misalign, on every single run, forever.
//
// So the shape is copied from `critic` — agents/critic.md, invokeCritic(), the
// `--critic` flag — and for the same reason: it is invoked BY HAND, with a
// specific target, when a human has decided it is needed. What is defensible
// against that research is a narrowly-scoped repairer that is handed an exact
// list of diagnostics and verified mechanically afterwards. What that research
// warns about is a general "fixes anything" role sitting in the module loop,
// running on every pass, negotiating ownership with the builder. This is the
// former and must not be allowed to drift into the latter: the repairer is not
// in PIPELINE_STAGES, is never auto-invoked, and nothing in the module loop
// calls it.
//
// Nothing in this file imports the Agent SDK, for the same reason
// module-prompt.ts does not: the prompt and the accept/reject decision are the
// two things most expensive to get wrong and most expensive to test live, so
// both must be renderable and testable by a script with no billable code in its
// import graph.

import path from "node:path";
import { diagnosticIdentity, parseDiagnostic } from "./baseline.js";
import type { ParsedDiagnostic } from "./baseline.js";
import type { TypecheckDiagnostics } from "./baseline.js";
import { DOCS_DIR, IMPLEMENTER_DOC } from "./module-prompt.js";

/** Where the repairer is told to look for the owning module's intent. */
const LLD_DOC = "docs/lld.md";

/** One diagnostic the repairer will be asked to fix, with who it belongs to. */
export interface RepairTarget {
  parsed: ParsedDiagnostic;
  /** Module id from the ledger's filesWritten, or null when no entry claims it. */
  owner: string | null;
}

export interface SelectRepairTargetsInput {
  /** A FRESH typecheck of the workspace. See selectRepairTargets' comment. */
  typecheck: TypecheckDiagnostics;
  /** file -> module id, from baseline.ts fileOwners(). */
  owners: ReadonlyMap<string, string>;
  /** When set, only diagnostics in files owned by this module are targeted. */
  moduleId: string | null;
}

/**
 * Chooses what to repair from the workspace's CURRENT diagnostics.
 *
 * The input is a fresh `tsc` run, deliberately NOT the ledger's stored
 * `inheritedDiagnostics`. The ledger records history: it says what was broken
 * during some module's attempt, which may since have been fixed, may have moved
 * line, or may have been joined by errors no module attempt ever observed. What
 * matters to a repair is what is broken right now, and the only thing that
 * knows that is the compiler. The ledger's role here is narrower and is the one
 * thing tsc cannot do: saying WHOSE file each diagnostic is in.
 *
 * Both tsc buckets are considered, for the reason baselineFrom gives — an
 * unresolved import (TS2307) in M04's file is as much M04's as a TS2345 in it
 * is, and which bucket a line landed in is a fact about dependency installs
 * rather than about ownership.
 *
 * Fileless diagnostics (`error TS5083: ...`, and the synthetic "tsc could not
 * be run" line) are excluded: they have no file, so they have no owner and no
 * file for the agent to open. They are surfaced to the caller separately rather
 * than silently dropped.
 */
export function selectRepairTargets(input: SelectRepairTargetsInput): {
  targets: RepairTarget[];
  /** Diagnostics not attributable to any file — reported, never handed to an agent. */
  unfixable: string[];
} {
  const targets: RepairTarget[] = [];
  const unfixable: string[] = [];

  for (const line of [...input.typecheck.errors, ...input.typecheck.missingModuleWarnings]) {
    const parsed = parseDiagnostic(line);
    if (parsed === null) continue;
    if (parsed.file.length === 0) {
      unfixable.push(parsed.raw);
      continue;
    }
    const owner = input.owners.get(parsed.file) ?? null;
    if (input.moduleId !== null && owner !== input.moduleId) continue;
    targets.push({ parsed, owner });
  }

  // Grouped by file so the prompt reads as "open this file, fix these", which
  // is the order the agent has to work in anyway.
  targets.sort((a, b) => {
    if (a.parsed.file !== b.parsed.file) return a.parsed.file.localeCompare(b.parsed.file);
    if (a.parsed.line !== b.parsed.line) return a.parsed.line - b.parsed.line;
    return a.parsed.column - b.parsed.column;
  });

  return { targets, unfixable };
}

/** `M04 x6, M01 x1` — owner breakdown of a target set, for logs and messages. */
export function describeTargetOwners(targets: readonly RepairTarget[]): string {
  const counts = new Map<string, number>();
  for (const target of targets) {
    const key = target.owner ?? "unattributed";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return (
    [...counts.entries()]
      .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
      .map(([owner, count]) => `${owner} x${count}`)
      .join(", ") || "none"
  );
}

/** Module ids that currently own at least one diagnostic, most first. */
export function ownersWithDiagnostics(targets: readonly RepairTarget[]): string[] {
  const counts = new Map<string, number>();
  for (const target of targets) {
    if (target.owner === null) continue;
    counts.set(target.owner, (counts.get(target.owner) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] !== a[1] ? b[1] - a[1] : a[0].localeCompare(b[0])))
    .map(([owner]) => owner);
}

/** Workspace-relative paths a target set touches, deduplicated and sorted. */
export function targetFiles(targets: readonly RepairTarget[]): string[] {
  return [...new Set(targets.map((t) => t.parsed.file))].sort();
}

/**
 * The verdict on a finished repair. `accepted` is the ONLY field that decides
 * whether the work is kept; the rest exist so a rejection can say why.
 */
export interface RepairVerdict {
  accepted: boolean;
  /** Targeted diagnostics that are gone. */
  fixed: string[];
  /** Targeted diagnostics that are still there. */
  remaining: string[];
  /**
   * Diagnostics present after the repair that were not present before, ANYWHERE
   * in the workspace — not only in the files the agent was asked about.
   */
  regressions: string[];
}

/**
 * Decides whether a repair is kept or rolled back.
 *
 * Two conditions, and the second is the one that makes any of this safe:
 *
 *   1. every targeted diagnostic is gone, AND
 *   2. no new diagnostic appeared ANYWHERE in the workspace.
 *
 * Condition 2 is not a nicety. The repairer is editing files that other modules
 * import, and the cheapest way to make seven errors disappear is to change a
 * shared signature — which moves the errors to the call sites instead of fixing
 * them. Checking only the targeted files would score that as a total success.
 * A repair that fixes three errors and introduces two is not a repair, and
 * there is no partial credit: the whole change is discarded.
 *
 * Comparison is by MULTISET of (file, code, message) identities, the same key
 * and the same counting baseline.ts uses, and for the same reasons — line
 * numbers move when a file is edited, which is precisely what a repair does, so
 * a line-sensitive key would score every surviving error below an edit as brand
 * new. Counting rather than set membership means two identical errors where
 * there was one is correctly seen as one new error.
 */
export function judgeRepair(
  before: TypecheckDiagnostics,
  after: TypecheckDiagnostics,
  targets: readonly RepairTarget[]
): RepairVerdict {
  const beforeCounts = countIdentities(before);
  const afterCounts = countIdentities(after);

  const regressions: string[] = [];
  for (const [key, entry] of afterCounts) {
    const wasThere = beforeCounts.get(key)?.count ?? 0;
    for (let i = 0; i < entry.count - wasThere; i += 1) regressions.push(entry.sample);
  }

  // How many occurrences of each identity were targeted. Several targets can
  // share an identity (the same error twice in one file), and all of them must
  // be gone for it to count as fixed.
  const targetedByKey = new Map<string, { count: number; samples: string[] }>();
  for (const target of targets) {
    const key = diagnosticIdentity(target.parsed);
    const bucket = targetedByKey.get(key) ?? { count: 0, samples: [] };
    bucket.count += 1;
    bucket.samples.push(target.parsed.raw);
    targetedByKey.set(key, bucket);
  }

  const fixed: string[] = [];
  const remaining: string[] = [];
  for (const [key, bucket] of targetedByKey) {
    const before_ = beforeCounts.get(key)?.count ?? bucket.count;
    const after_ = afterCounts.get(key)?.count ?? 0;
    // Allowed to survive: whatever was there beyond what we targeted.
    const permitted = Math.max(0, before_ - bucket.count);
    const stillThere = Math.max(0, after_ - permitted);
    for (let i = 0; i < bucket.count; i += 1) {
      if (i < bucket.count - stillThere) fixed.push(bucket.samples[i] ?? key);
      else remaining.push(bucket.samples[i] ?? key);
    }
  }

  return {
    accepted: regressions.length === 0 && remaining.length === 0,
    fixed,
    remaining,
    regressions,
  };
}

function countIdentities(
  typecheck: TypecheckDiagnostics
): Map<string, { count: number; sample: string }> {
  const counts = new Map<string, { count: number; sample: string }>();
  for (const line of [...typecheck.errors, ...typecheck.missingModuleWarnings]) {
    const parsed = parseDiagnostic(line);
    if (parsed === null) continue;
    const key = diagnosticIdentity(parsed);
    const existing = counts.get(key);
    if (existing === undefined) counts.set(key, { count: 1, sample: parsed.raw });
    else existing.count += 1;
  }
  return counts;
}

/**
 * The repairer's instruction.
 *
 * The diagnostics are pasted VERBATIM and in full. This is the opposite choice
 * from buildModulePrompt, which refuses to paste docs/lld.md — and the
 * difference is the point. The module prompt omits a thousand-line document the
 * agent can Grep for; this prompt includes the single short list that defines
 * the entire job. An agent asked to "fix the type errors" would have to decide
 * which ones, and deciding which ones is precisely the freedom that must not be
 * given to something editing another module's files.
 *
 * `workspace` and `docsDir` are parameters rather than reads of workspaceRoot()
 * so the prompt can be rendered for an arbitrary workspace by a test.
 */
export function buildRepairPrompt(options: {
  targets: readonly RepairTarget[];
  workspace: string;
  docsDir?: string;
  /** The module being targeted, when the invocation named one. */
  moduleId: string | null;
}): string {
  const { targets, workspace, moduleId } = options;
  const docsDir = options.docsDir ?? DOCS_DIR;
  const files = targetFiles(targets);
  const owners = [...new Set(targets.map((t) => t.owner).filter((o): o is string => o !== null))];

  const scope =
    moduleId === null
      ? `These are all of the workspace's outstanding typecheck diagnostics that belong to a file some module wrote.`
      : `These are the outstanding typecheck diagnostics in files written by ${moduleId}.`;

  const byFile = files
    .map((file) => {
      const lines = targets
        .filter((t) => t.parsed.file === file)
        .map((t) => `  ${t.parsed.raw}`)
        .join("\n");
      const owner = targets.find((t) => t.parsed.file === file)?.owner;
      return `${file}  (written by ${owner ?? "a module the ledger does not identify"})\n${lines}`;
    })
    .join("\n\n");

  const intent =
    owners.length > 0
      ? `These files were written by ${owners.join(", ")}. Before you edit, Grep ${path.join(
          docsDir,
          "lld.md"
        )} and ${path.join(docsDir, "implementer.md")} for ${owners
          .map((o) => `"${o}"`)
          .join(" and ")} and read those sections, so your fix matches what the module was ` +
        `specified to do rather than merely what makes the compiler stop. Do not read either ` +
        `document end to end. Both are READ-ONLY — never write to ${docsDir}.`
      : `The ledger does not identify which module wrote these files, so there is no specification ` +
        `section to read. Infer intent from the code itself and stay conservative.`;

  return [
    `You have been invoked on demand to repair specific typecheck errors. You are not running as a pipeline stage and you are not building a module.`,
    `Your working directory is ${workspace}. ${scope} There are ${targets.length} of them, in ${files.length} file(s):`,
    byFile,
    `Fix exactly these ${targets.length} diagnostic(s). Touch only the ${files.length} file(s) listed above. Add no features, no refactors, no renames, no reformatting, and no "while I'm here" improvements — every line you change must be traceable to one of the diagnostics above.`,
    `Do not silence the errors with \`any\`, \`as unknown as\`, \`@ts-ignore\`, or by widening a type until it stops complaining. Fix the actual mismatch the compiler is describing.`,
    intent,
    `The line and column numbers above are from a typecheck taken just now, so they are current — but they will shift as you edit, so re-read a file before making a second change to it.`,
    `When you finish, the orchestrator runs a fresh \`tsc --noEmit\` over the WHOLE workspace and keeps your work only if every diagnostic above is gone AND no new diagnostic appeared anywhere. Fixing some of these by breaking something else is rejected in full, and the workspace is reset to the commit taken before you started. If one of these cannot be fixed without editing a file that is not on your list, or without a dependency that is not installed, leave it and say so in your final message — that is a useful answer and a suppression is not.`,
    `You have no shell and cannot run the compiler yourself. Report what you changed, per diagnostic, in your final message.`,
  ].join("\n\n");
}

export { IMPLEMENTER_DOC, LLD_DOC };
