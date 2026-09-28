// The code workspace: where spec-implementer's generated product lives.
//
// It is deliberately OUTSIDE this git repository. The repo root holds the
// user's own untracked work (reelbanao/, projects/, research-archive/), and
// untracked means unrecoverable — a code-writing agent running under
// `permissionMode: 'bypassPermissions'` must not be pointed anywhere near it.
// Generated code therefore goes to ~/agent-pipeline-workspace by default, in
// its own git history, overridable with PIPELINE_WORKSPACE.
//
// Everything here is orchestrator-side. The agent has no shell (see
// agents/spec-implementer.md and docs/lld.md LD-1), so bootstrapping, git,
// dependency installation (orchestrator/deps.ts) and typechecking are all run by
// this process, never by the agent.

import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { PROJECT_ROOT } from "./agent-loader.js";

const execFileAsync = promisify(execFile);

/** Default workspace location when PIPELINE_WORKSPACE is not set. */
const DEFAULT_WORKSPACE_DIR = path.join(os.homedir(), "agent-pipeline-workspace");

/** Directories never walked when snapshotting or scanning the workspace. */
const IGNORED_DIRS = new Set([".git", "node_modules", "dist", ".next", "build", "coverage"]);

/** Orchestrator-owned bookkeeping files; not part of the generated product. */
export const PROGRESS_JSON = "pipeline-progress.json";
export const PROGRESS_MD = "PROGRESS.md";
/**
 * Where orchestrator/deps.ts records the hash of the last dependency set it
 * successfully installed. Lives in the workspace because that is what the fact
 * is about — this workspace's `node_modules` — and is excluded from
 * `changedFiles()` like the other two, so it can never be mistaken for output
 * the agent wrote.
 */
export const INSTALL_STATE_FILE = ".pipeline-install-state.json";

/**
 * Where generated code goes. Resolved once per process so every caller agrees,
 * and resolved to an absolute path so it can be handed to the SDK as `cwd`.
 */
export function workspaceRoot(): string {
  const fromEnv = process.env.PIPELINE_WORKSPACE;
  const chosen =
    typeof fromEnv === "string" && fromEnv.trim().length > 0 ? fromEnv.trim() : DEFAULT_WORKSPACE_DIR;
  return path.resolve(chosen.startsWith("~") ? chosen.replace(/^~/, os.homedir()) : chosen);
}

/**
 * What kind of product the workspace's package.json says it is.
 *
 * This is deliberately a THREE-valued answer rather than a boolean, because the
 * three cases want genuinely different compiler options and collapsing any two
 * of them degrades one of them.
 */
export type WorkspaceRuntime =
  /** `next` is declared: a Next.js app, typechecked the way create-next-app does. */
  | "next"
  /** `react` without `next`: a React library/app compiled by some other bundler. */
  | "react"
  /** Neither: a plain Node library, which is what this pipeline started out assuming. */
  | "node";

/**
 * WHY THE CONFIG IS DERIVED RATHER THAN FIXED
 * -------------------------------------------
 * A fixed Node-library tsconfig does not merely fail to help a web product — it
 * SHAPES it. With `jsx` unset, `tsc` rejects every `.tsx` file outright
 * (TS17004), so the agent, which is verified by this typecheck, writes
 * `createElement as h(...)` calls instead of JSX. With `moduleResolution:
 * NodeNext`, `import { notFound } from 'next/navigation'` — the import every
 * Next.js codebase writes — fails TS2307, and a repair pass "fixes" it to
 * `'next/navigation.js'`. Both artefacts were observed in the live workspace.
 * Neither is a bug the agent chose; both are the verifier's config leaking into
 * the product's source.
 *
 * So the config follows the product's own declaration. The reference for the
 * Next case is what `create-next-app --typescript` generates, not invention.
 *
 * `strict: true` is NOT derived. It is the verifier's value and holds in every
 * case.
 */
function compilerOptionsFor(runtime: WorkspaceRuntime): Record<string, unknown> {
  switch (runtime) {
    case "next":
      // create-next-app's TS template, minus the two pieces that are not ours
      // to invent: `paths` (the product's own alias scheme) and `plugins`
      // (a tsserver-only plugin that `tsc --noEmit` ignores). `incremental` is
      // also left off — it writes a .tsbuildinfo into the workspace that would
      // show up in `changedFiles()` as output the agent did not write.
      return {
        target: "ES2022",
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "preserve",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        strict: true,
        noEmit: true,
        allowJs: true,
        skipLibCheck: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        isolatedModules: true,
      };
    case "react":
      // No Next.js compiler to hand the JSX to, so it is compiled here:
      // `react-jsx` is the automatic runtime, which needs no `import React`.
      return {
        target: "ES2022",
        module: "esnext",
        moduleResolution: "bundler",
        jsx: "react-jsx",
        lib: ["ES2022", "DOM", "DOM.Iterable"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
        isolatedModules: true,
      };
    case "node":
      // Byte-for-byte what this file has always emitted. Non-web products must
      // be completely unaffected by the two branches above.
      return {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        lib: ["ES2022", "DOM"],
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        esModuleInterop: true,
        allowSyntheticDefaultImports: true,
        forceConsistentCasingInFileNames: true,
        resolveJsonModule: true,
      };
  }
}

/**
 * The runtime a manifest declares. `next` wins over `react` because every Next
 * app also declares `react`, and the Next answer is the more specific one.
 *
 * Both `dependencies` and `devDependencies` are consulted: which of the two a
 * model puts `next` in is not a fact worth depending on.
 */
export function detectWorkspaceRuntime(manifest: unknown): WorkspaceRuntime {
  if (typeof manifest !== "object" || manifest === null) return "node";
  const record = manifest as Record<string, unknown>;
  const declared = new Set<string>();
  for (const field of ["dependencies", "devDependencies"] as const) {
    const section = record[field];
    if (typeof section !== "object" || section === null || Array.isArray(section)) continue;
    for (const name of Object.keys(section as Record<string, unknown>)) declared.add(name);
  }
  if (declared.has("next")) return "next";
  if (declared.has("react")) return "react";
  return "node";
}

/**
 * The workspace tsconfig.
 *
 * EVERY PATH IN IT IS RELATIVE, AND THAT IS THE POINT. This file is written
 * into the workspace and COMMITTED to the generated product's own git history,
 * so an absolute path in it is a path that is wrong on every machine except the
 * one that wrote it. It used to carry one:
 *
 *   typeRoots: ["./node_modules/@types", "/Users/<me>/agent-files/.../node_modules/@types"]
 *
 * — this repo's own `@types`, reached into from the workspace. On a Mac that
 * read `/Users/...`; resuming the same build in a Linux container rewrote it to
 * `/home/user/...`; a checkout on a third machine pointed at a directory that
 * does not exist. Every machine rewrote a committed file, and `rewritten` is not
 * free: it buys the module being built an attribution allowance (see
 * attributeDiagnostics) for a change it did not cause.
 *
 * WHY IT WAS THERE, AND WHY IT NO LONGER NEEDS TO BE. The agent has no shell, so
 * nothing in the workspace could ever run `npm install`, and a generated file
 * touching `process`/`Buffer`/`console` failed TS2304 "cannot find name" —
 * rejecting every module for a reason that has nothing to do with the module.
 * That predates orchestrator/deps.ts, which installs into the workspace on the
 * orchestrator's behalf. So the workspace now DECLARES `@types/node` in its own
 * package.json (workspacePackageJson / ensureNodeTypesDeclared) and the install
 * puts it under the workspace's own `./node_modules/@types`. Self-sufficient
 * instead of borrowing, and portable as a result.
 *
 * `lib` still includes DOM, for the browser-side half of the same problem.
 *
 * Third-party imports resolve only once orchestrator/deps.ts has installed the
 * dependencies the agent declared in package.json. Until then they surface as
 * TS2307, which the verifier downgrades to a warning; after a successful
 * install a TS2307 means an UNDECLARED import and fails the module. See
 * classifyTypecheck and verifyModule.
 */
export function workspaceTsconfig(runtime: WorkspaceRuntime = "node"): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        ...compilerOptionsFor(runtime),
        typeRoots: ["./node_modules/@types"],
      },
      include: ["**/*.ts", "**/*.tsx"],
      exclude: ["node_modules", "dist"],
    },
    null,
    2
  )}\n`;
}

export interface TsconfigSyncResult {
  /** What the manifest was read as. "node" is also the fallback on a bad read. */
  runtime: WorkspaceRuntime;
  /** True only when the file on disk actually differed and was replaced. */
  rewritten: boolean;
  /** Human-facing lines for the run log, already prefixed. */
  log: string[];
}

/**
 * Re-derives the workspace tsconfig from the currently declared dependencies
 * and writes it only if the content actually changed.
 *
 * WHY THIS IS NOT A BOOTSTRAP-ONLY CONCERN. At bootstrap the workspace
 * package.json declares nothing at all — modules add dependencies as they build
 * — so the runtime is unknowable then and `ensureWorkspace` can only emit the
 * "node" config. The answer changes the moment a module declares `next`. This
 * is therefore called from orchestrator/deps.ts, which already sits at exactly
 * the point where the declared set may have just changed, and always BEFORE the
 * typecheck that the config governs.
 *
 * The compare-before-write is not an optimisation: rewriting an identical file
 * would set `rewritten`, and `rewritten` buys the current module an attribution
 * allowance it has not earned (see attributeDiagnostics). An unchanged run must
 * report false.
 *
 * NEVER THROWS, for the same reason deps.ts does not: a workspace whose
 * tsconfig could not be re-derived still typechecks with the one already there.
 */
export async function syncWorkspaceTsconfig(root?: string): Promise<TsconfigSyncResult> {
  const dir = root ?? workspaceRoot();
  const file = path.join(dir, "tsconfig.json");

  let manifest: unknown = null;
  try {
    manifest = JSON.parse(await readFile(path.join(dir, "package.json"), "utf-8")) as unknown;
  } catch {
    // No readable manifest: nothing declares anything, so there is nothing to
    // derive from and the existing file is left exactly as it is.
    return { runtime: "node", rewritten: false, log: [] };
  }

  const runtime = detectWorkspaceRuntime(manifest);
  const desired = workspaceTsconfig(runtime);

  let current: string | null = null;
  try {
    current = await readFile(file, "utf-8");
  } catch {
    current = null;
  }
  if (current === desired) return { runtime, rewritten: false, log: [] };

  try {
    await writeFile(file, desired, "utf-8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      runtime,
      rewritten: false,
      log: [`[tsconfig] could not rewrite the workspace tsconfig (keeping the existing one): ${detail}`],
    };
  }

  return {
    runtime,
    rewritten: true,
    log: [
      `[tsconfig] workspace tsconfig re-derived for a "${runtime}" product from the currently ` +
        `declared dependencies and rewritten; the diagnostic set for the WHOLE workspace may ` +
        `have changed as a result`,
    ],
  };
}

/**
 * The `@types/node` range the workspace declares for itself.
 *
 * Pinned to the same major this repo has installed, because that is literally
 * what the workspace used to borrow through `typeRoots` — same types, now
 * fetched into the workspace instead of reached into across the filesystem.
 * A caret range, so the product can be nudged forward without editing code, and
 * NEVER overwritten when the generated package.json already names a version:
 * the product's own choice wins (see ensureNodeTypesDeclared).
 */
export const WORKSPACE_NODE_TYPES_RANGE = "^20.14.0";

function workspacePackageJson(): string {
  return `${JSON.stringify(
    {
      name: "agent-pipeline-product",
      version: "0.0.0",
      private: true,
      type: "module",
      description:
        "Generated by the agent-pipeline spec-implementer stage. Not hand-written; see PROGRESS.md.",
      scripts: { typecheck: "tsc --noEmit" },
      // Declared at bootstrap rather than left to the agent, and the reason is
      // in workspaceTsconfig: `process`, `Buffer` and `console` are TS2304
      // without it, which fails modules for something no module did. Declaring
      // it here is what lets `typeRoots` stay relative — the types arrive in
      // the workspace's OWN node_modules, via the same install every other
      // dependency uses (orchestrator/deps.ts).
      devDependencies: { "@types/node": WORKSPACE_NODE_TYPES_RANGE },
    },
    null,
    2
  )}\n`;
}

/**
 * Adds `@types/node` to an EXISTING workspace package.json that does not
 * declare it.
 *
 * Bootstrap's writeIfAbsent only helps a workspace created after this change.
 * A workspace built before it has a package.json that is already there and that
 * an agent has since edited — and the moment `typeRoots` stopped naming this
 * repo, that workspace lost its only source of Node globals. So the declaration
 * is ensured on every bootstrap, not just on creation.
 *
 * Strictly additive, and only when the key is absent: a version the generated
 * product chose for itself is the product's decision and is left alone. Returns
 * true only when the file was actually changed, and never throws — a workspace
 * whose manifest could not be read still typechecks with whatever it has.
 */
export async function ensureNodeTypesDeclared(root: string): Promise<boolean> {
  const file = path.join(root, "package.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(file, "utf-8")) as unknown;
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;

  const manifest = parsed as Record<string, unknown>;
  for (const field of ["dependencies", "devDependencies"] as const) {
    const section = manifest[field];
    if (typeof section !== "object" || section === null || Array.isArray(section)) continue;
    if ("@types/node" in (section as Record<string, unknown>)) return false;
  }

  const existing = manifest["devDependencies"];
  const devDependencies: Record<string, unknown> =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  devDependencies["@types/node"] = WORKSPACE_NODE_TYPES_RANGE;
  manifest["devDependencies"] = devDependencies;

  try {
    await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    return true;
  } catch {
    return false;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** Writes `contents` only if `file` is absent. Never clobbers existing work. */
async function writeIfAbsent(file: string, contents: string): Promise<boolean> {
  if (await pathExists(file)) return false;
  await writeFile(file, contents, "utf-8");
  return true;
}

export interface WorkspaceBootstrapReport {
  root: string;
  created: string[];
}

/**
 * Creates the workspace if it does not exist, and fills in only the pieces that
 * are missing. Idempotent by construction: a second run reports an empty
 * `created` list and touches nothing, so resuming a partially-built product is
 * safe.
 */
export async function ensureWorkspace(): Promise<WorkspaceBootstrapReport> {
  const root = workspaceRoot();
  const created: string[] = [];

  if (!(await pathExists(root))) {
    await mkdir(root, { recursive: true });
    created.push(`${root}/`);
  }

  if (await writeIfAbsent(path.join(root, "package.json"), workspacePackageJson())) {
    created.push("package.json");
  } else if (await ensureNodeTypesDeclared(root)) {
    // A workspace bootstrapped before the tsconfig stopped borrowing this
    // repo's @types. Give it the declaration it now depends on.
    created.push(`package.json (added @types/node ${WORKSPACE_NODE_TYPES_RANGE})`);
  }
  if (await writeIfAbsent(path.join(root, "tsconfig.json"), workspaceTsconfig())) {
    created.push("tsconfig.json");
  }
  // node_modules/ must stay ignored: orchestrator/deps.ts installs the
  // dependencies the agent declared into the workspace, and committing a
  // model-chosen dependency tree into the generated product's history is not
  // something anyone asked for.
  const gitignore = "node_modules/\ndist/\n";
  if (await writeIfAbsent(path.join(root, ".gitignore"), gitignore)) {
    created.push(".gitignore");
  }

  // Its own history, separate from the pipeline repo's. `git init` is itself
  // idempotent, but checking first keeps `created` honest.
  if (!(await pathExists(path.join(root, ".git")))) {
    try {
      await execFileAsync("git", ["init", "--quiet"], { cwd: root });
      created.push(".git/");
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(`  [workspace] git init failed (continuing without version control): ${detail}`);
    }
  }

  return { root, created };
}

/** size+mtime of every non-ignored file, keyed by workspace-relative path. */
export type WorkspaceSnapshot = Map<string, string>;

async function walk(dir: string, root: string, into: WorkspaceSnapshot): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      await walk(full, root, into);
      continue;
    }
    if (!entry.isFile()) continue;
    try {
      const info = await stat(full);
      into.set(path.relative(root, full), `${info.size}:${info.mtimeMs}`);
    } catch {
      // Raced with a delete; simply absent from this snapshot.
    }
  }
}

/** Snapshots the workspace so a later diff can prove a call wrote something. */
export async function snapshotWorkspace(): Promise<WorkspaceSnapshot> {
  const root = workspaceRoot();
  const snapshot: WorkspaceSnapshot = new Map();
  await walk(root, root, snapshot);
  return snapshot;
}

/**
 * Files created or modified between two snapshots, as workspace-relative paths.
 * Orchestrator bookkeeping files — the ledger, PROGRESS.md and the dependency
 * install state — are excluded so they can never be mistaken for the agent's
 * output. Deletions are ignored: the question this answers is
 * "did this call write anything", not "what changed".
 */
export function changedFiles(before: WorkspaceSnapshot, after: WorkspaceSnapshot): string[] {
  const changed: string[] = [];
  for (const [file, fingerprint] of after) {
    if (file === PROGRESS_JSON || file === PROGRESS_MD || file === INSTALL_STATE_FILE) continue;
    if (before.get(file) !== fingerprint) changed.push(file);
  }
  return changed.sort();
}

export interface TypecheckResult {
  /** Process exit code; 0 means tsc found nothing at all. */
  exitCode: number;
  /** Diagnostics for unresolved imports (TS2307) — downgraded to warnings. */
  missingModuleWarnings: string[];
  /** Every other diagnostic line — any of these fails the module. */
  errors: string[];
  /** Raw tsc output, kept for the progress log when something fails. */
  raw: string;
}

/** `src/a.ts(3,25): error TS2307: Cannot find module 'zod'...` */
const DIAGNOSTIC_RE = /error TS(\d+):/;

/**
 * Splits tsc output into "missing dependency" noise and real errors.
 *
 * TS2307 ("Cannot find module X or its corresponding type declarations") gets
 * its own bucket because its MEANING depends on whether a dependency install has
 * succeeded, which this function has no business knowing. Unresolved-import
 * lines are separated here; verifyModule decides whether they are the expected
 * consequence of an uninstalled workspace (a warning) or an import the agent
 * never declared in package.json (a failure). Every other diagnostic code is a
 * genuine defect in generated code and fails the module unconditionally.
 *
 * Only lines containing `error TS<number>:` are classified; tsc's indented
 * continuation lines are left in `raw` and counted against neither bucket.
 */
export function classifyTypecheck(exitCode: number, output: string): TypecheckResult {
  const missingModuleWarnings: string[] = [];
  const errors: string[] = [];

  for (const line of output.split(/\r?\n/)) {
    const match = DIAGNOSTIC_RE.exec(line);
    if (match === null) continue;
    if (match[1] === "2307") missingModuleWarnings.push(line.trim());
    else errors.push(line.trim());
  }

  return { exitCode, missingModuleWarnings, errors, raw: output };
}

/**
 * Runs `tsc --noEmit` against the workspace, using this repo's TypeScript
 * binary (the workspace's own `node_modules`, when deps.ts has populated it,
 * holds the generated product's dependencies, not a compiler we want to run).
 * This is the orchestrator's own check — success is never the agent's
 * self-report.
 */
export async function typecheckWorkspace(): Promise<TypecheckResult> {
  const root = workspaceRoot();
  const tsc = path.join(PROJECT_ROOT, "node_modules", "typescript", "bin", "tsc");

  try {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      [tsc, "--noEmit", "--pretty", "false", "-p", path.join(root, "tsconfig.json")],
      { cwd: root, maxBuffer: 32 * 1024 * 1024 }
    );
    return classifyTypecheck(0, `${stdout}${stderr}`);
  } catch (err) {
    const failure = err as { code?: unknown; stdout?: unknown; stderr?: unknown; message?: unknown };
    const stdout = typeof failure.stdout === "string" ? failure.stdout : "";
    const stderr = typeof failure.stderr === "string" ? failure.stderr : "";
    const combined = `${stdout}${stderr}`;
    const exitCode = typeof failure.code === "number" ? failure.code : 1;
    if (combined.trim().length === 0) {
      // tsc could not be launched at all — that is a config fault, not a
      // module failure, and must not be reported as "the code is fine".
      const detail = typeof failure.message === "string" ? failure.message : String(err);
      return {
        exitCode,
        missingModuleWarnings: [],
        errors: [`tsc could not be run: ${detail}`],
        raw: detail,
      };
    }
    return classifyTypecheck(exitCode, combined);
  }
}

/**
 * Filters a list of workspace-relative paths down to the ones that still exist.
 *
 * Used before telling a retried module to "read and repair the files your last
 * attempt wrote": if a human reverted or deleted that output between runs, the
 * instruction is a lie and sends the agent looking for files that are not there.
 * `stat` rather than a read, because the contents are the agent's job, not ours.
 */
export async function existingWorkspaceFiles(relPaths: readonly string[]): Promise<string[]> {
  const present: string[] = [];
  for (const relPath of relPaths) {
    try {
      await stat(path.join(workspaceRoot(), relPath));
      present.push(relPath);
    } catch {
      // Absent or unreadable: either way it cannot be read and repaired.
    }
  }
  return present;
}

/** Reads a workspace file, returning null when it is unreadable. */
export async function readWorkspaceFile(relPath: string): Promise<string | null> {
  try {
    return await readFile(path.join(workspaceRoot(), relPath), "utf-8");
  } catch {
    return null;
  }
}
