// Installing the workspace's declared dependencies, so the typecheck can see them.
//
// WHY THIS EXISTS
// --------------
// spec-implementer has no shell (Decision LD-1), so nothing in the workspace
// ever ran `npm install`. Every generated file importing `kysely`, `pg`,
// `pino`, `@opentelemetry/*` therefore produced TS2307 "Cannot find module",
// which the verifier downgrades to a warning — correctly, given nothing is
// installed. The cost is invisible and large: tsc cannot check ANYTHING in a
// file whose imports it cannot resolve. On the first live run, M01 ("Platform
// foundation": db, redis, S3, secrets, telemetry — almost entirely third-party
// integration) was verified almost not at all; across three attempts the only
// errors that surfaced were on local `./types.js` / `./errors.js` imports.
//
// The orchestrator is trusted code and runs the install itself. That is the
// same argument that already justifies the orchestrator running `tsc`.
//
// WHY THIS IS SAFE
// ----------------
// The package list comes from an agent-written package.json: a model chose
// those names. `--ignore-scripts` is therefore MANDATORY and is the entire
// basis on which this feature is acceptable. With npm lifecycle scripts
// disabled (preinstall/install/postinstall/prepare), no code from any installed
// package is ever executed by installing it, and nothing in this pipeline ever
// runs the generated product — `tsc --noEmit` only parses `.d.ts` declarations.
// Do not remove that flag as a "cleanup"; without it, an arbitrary
// model-chosen package name becomes arbitrary code execution on this machine.
//
// The other three guards, for the same reason:
//   - every package name and version is printed before installing, so a human
//     can see what a model decided to pull in;
//   - the install runs with the WORKSPACE as cwd, never the project root;
//   - `--no-install` turns the whole thing off without editing code.

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { INSTALL_STATE_FILE, workspaceRoot } from "./workspace.js";

const execFileAsync = promisify(execFile);

// INSTALL_STATE_FILE — where the hash of the last successfully-installed
// dependency set is recorded — is declared in workspace.ts, next to the progress
// ledger's filenames. The workspace is the natural home for it: the fact is
// about THAT workspace's node_modules, not about this repo or this process. It
// lives with the other orchestrator-owned bookkeeping names so `changedFiles()`
// can exclude it from the agent's "files written" just as it excludes the ledger.

/** A hanging registry call must not stall a run forever. */
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

const MAX_INSTALL_BUFFER = 16 * 1024 * 1024;

/** How many package names to print before truncating the list. */
const MAX_LISTED_PACKAGES = 40;

export type InstallStatus =
  /** npm install ran and exited 0 for the currently declared set. */
  | "installed"
  /** The declared set is byte-identical to the last successful install. */
  | "unchanged"
  /** `--no-install` was passed. */
  | "disabled"
  /** package.json declares no dependencies at all. */
  | "no-dependencies"
  /** package.json is missing or unparseable. */
  | "no-manifest"
  /** npm install was attempted and did not succeed. */
  | "failed";

export interface InstallOutcome {
  status: InstallStatus;
  /**
   * THE state flag the verifier branches on: true only when the workspace's
   * `node_modules` is known to match the dependency set currently declared in
   * package.json, because an install succeeded for exactly that set.
   *
   * When this is true, a TS2307 is no longer "nothing is installed" — it means
   * the agent imported a package it never declared, which is a real defect.
   * When it is false (disabled, failed, never run, nothing declared), TS2307
   * keeps its existing warning treatment. Getting this backwards either fails
   * every module or makes the typecheck verifier useless, so it is computed in
   * exactly one place — here — and never re-derived from the status elsewhere.
   */
  dependenciesResolved: boolean;
  /** Hash of the declared dependency set, or null when there is nothing to hash. */
  hash: string | null;
  /** `name@range` for every declared dependency, dependencies then devDependencies. */
  packages: string[];
  /** Human-facing lines for the run log, in order, each already prefixed `[deps]`. */
  log: string[];
}

interface DeclaredDependencies {
  packages: string[];
  hash: string;
  count: number;
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((v) => typeof v === "string");
}

function sortedEntries(value: unknown): Array<[string, string]> {
  if (!isStringRecord(value)) return [];
  return Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * Reads the workspace package.json and summarises its declared dependencies.
 *
 * The hash covers the `dependencies` and `devDependencies` objects only, with
 * keys sorted, so re-ordering or reformatting package.json does not trigger a
 * reinstall while adding, removing or re-ranging a package does. Returns null
 * when there is no readable manifest or it declares nothing.
 */
export async function readDeclaredDependencies(root: string): Promise<DeclaredDependencies | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path.join(root, "package.json"), "utf-8")) as unknown;
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;

  const manifest = parsed as Record<string, unknown>;
  const deps = sortedEntries(manifest["dependencies"]);
  const devDeps = sortedEntries(manifest["devDependencies"]);
  if (deps.length === 0 && devDeps.length === 0) return null;

  const hash = createHash("sha256")
    .update(JSON.stringify({ dependencies: deps, devDependencies: devDeps }))
    .digest("hex");

  return {
    packages: [...deps, ...devDeps].map(([name, range]) => `${name}@${range}`),
    hash,
    count: deps.length + devDeps.length,
  };
}

interface InstallState {
  hash: string;
}

async function readInstallState(root: string): Promise<InstallState | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(root, INSTALL_STATE_FILE), "utf-8")) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    const hash = (parsed as Record<string, unknown>)["hash"];
    return typeof hash === "string" && hash.length > 0 ? { hash } : null;
  } catch {
    return null;
  }
}

async function writeInstallState(root: string, hash: string, packages: string[]): Promise<void> {
  const body = `${JSON.stringify(
    {
      hash,
      installedAt: new Date().toISOString(),
      command: "npm install --ignore-scripts",
      packages,
      note:
        "Written by the agent-pipeline orchestrator after a successful workspace dependency " +
        "install. The hash covers package.json's dependencies + devDependencies; while it " +
        "matches, the install is skipped and unresolved imports are treated as real errors.",
    },
    null,
    2
  )}\n`;
  await writeFile(path.join(root, INSTALL_STATE_FILE), body, "utf-8");
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function describePackages(declared: DeclaredDependencies): string[] {
  const shown = declared.packages.slice(0, MAX_LISTED_PACKAGES);
  const lines = shown.map((pkg) => `[deps]   ${pkg}`);
  if (declared.packages.length > shown.length) {
    lines.push(`[deps]   ...and ${declared.packages.length - shown.length} more`);
  }
  return lines;
}

function errorDetail(err: unknown): string {
  const failure = err as { stderr?: unknown; stdout?: unknown; message?: unknown; killed?: unknown };
  const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
  const stdout = typeof failure.stdout === "string" ? failure.stdout.trim() : "";
  const base = stderr.length > 0 ? stderr : stdout.length > 0 ? stdout : "";
  const message = typeof failure.message === "string" ? failure.message : String(err);
  const timedOut = failure.killed === true;
  const detail = (base.length > 0 ? base : message).replace(/\s+/g, " ").trim().slice(0, 400);
  return timedOut
    ? `timed out after ${INSTALL_TIMEOUT_MS / 1000}s and was killed: ${detail}`
    : detail;
}

export interface InstallOptions {
  /** False when the human passed `--no-install`. */
  enabled: boolean;
  /** Workspace directory. Defaults to workspaceRoot(); injectable for tests. */
  root?: string;
}

/**
 * Installs the workspace's declared dependencies if, and only if, that set has
 * changed since the last successful install.
 *
 * Called after a module's agent call returns and BEFORE the typecheck, because
 * that is the moment package.json may have just gained entries.
 *
 * NEVER THROWS. A missing network, a package name the model invented, a
 * registry 500, a hanging install — all of those are logged and reported as
 * `status: "failed"`, `dependenciesResolved: false`, which falls straight
 * through to the pre-existing behaviour where TS2307 is a warning. A
 * dependency install failing is not the agent writing bad code and must not be
 * recorded as if it were.
 */
export async function installWorkspaceDependencies(options: InstallOptions): Promise<InstallOutcome> {
  const root = options.root ?? workspaceRoot();

  if (!options.enabled) {
    return {
      status: "disabled",
      dependenciesResolved: false,
      hash: null,
      packages: [],
      log: [
        "[deps] dependency install disabled by --no-install; unresolved third-party imports " +
          "stay warnings and the typecheck cannot see inside files that import them",
      ],
    };
  }

  const declared = await readDeclaredDependencies(root);
  if (declared === null) {
    // No manifest and "a manifest declaring nothing" are the same situation for
    // the caller: there is nothing to install, so no install has succeeded, so
    // TS2307 keeps its warning treatment. Deliberately NOT treated as
    // "resolved": an agent that imports `pg` without declaring it is exactly
    // the case this state covers, and calling it resolved here would fail the
    // module on the strength of an install that never ran.
    const manifest = await pathExists(path.join(root, "package.json"));
    return {
      status: manifest ? "no-dependencies" : "no-manifest",
      dependenciesResolved: false,
      hash: null,
      packages: [],
      log: [
        manifest
          ? "[deps] workspace package.json declares no dependencies — nothing to install; " +
            "unresolved imports stay warnings"
          : "[deps] workspace has no readable package.json — nothing to install; " +
            "unresolved imports stay warnings",
      ],
    };
  }

  const previous = await readInstallState(root);
  const nodeModulesPresent = await pathExists(path.join(root, "node_modules"));
  if (previous !== null && previous.hash === declared.hash && nodeModulesPresent) {
    return {
      status: "unchanged",
      dependenciesResolved: true,
      hash: declared.hash,
      packages: declared.packages,
      log: [
        `[deps] ${declared.count} declared dependency/ies unchanged since the last successful ` +
          `install (set ${declared.hash.slice(0, 12)}); skipping npm install`,
      ],
    };
  }

  const log: string[] = [
    `[deps] installing ${declared.count} dependency/ies declared in the agent-written ` +
      `package.json into ${root}:`,
    ...describePackages(declared),
    "[deps] running `npm install --ignore-scripts` (lifecycle scripts disabled, so no code " +
      "from any of these packages executes; pass --no-install to skip dependency installs)",
  ];

  const startedAt = Date.now();
  try {
    await execFileAsync(
      "npm",
      ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel", "error"],
      {
        // Scoped to the workspace, never the project root.
        cwd: root,
        timeout: INSTALL_TIMEOUT_MS,
        maxBuffer: MAX_INSTALL_BUFFER,
      }
    );
  } catch (err) {
    log.push(
      `[deps] install FAILED — continuing without it; unresolved imports stay warnings and this ` +
        `does NOT fail the module: ${errorDetail(err)}`
    );
    return { status: "failed", dependenciesResolved: false, hash: declared.hash, packages: declared.packages, log };
  }

  const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);
  try {
    await writeInstallState(root, declared.hash, declared.packages);
  } catch (err) {
    // The install itself worked, so imports DO resolve; only the skip-next-time
    // optimisation is lost. Say so rather than pretending the install failed.
    const detail = err instanceof Error ? err.message : String(err);
    log.push(`[deps] could not record the install state (the next module will reinstall): ${detail}`);
  }
  log.push(
    `[deps] installed ${declared.count} dependency/ies in ${seconds}s — unresolved imports are ` +
      `now real failures, because every declared package is present`
  );

  return { status: "installed", dependenciesResolved: true, hash: declared.hash, packages: declared.packages, log };
}
