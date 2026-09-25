// Workspace version control: snapshot before a risky edit, restore after a bad one.
//
// WHY THIS EXISTS
// ---------------
// The repairer (orchestrator/repair.ts, invokeRepairer in run.ts) lets an agent
// edit files that some OTHER module wrote, which is a thing nothing else in this
// pipeline is permitted to do. The safety property that makes it acceptable is
// not "the agent is careful" — it is that the workspace is committed before the
// agent runs and reset to that commit if the repair is not accepted. A failed
// repair must leave the workspace byte-identical to how it found it.
//
// `git` is invoked through `execFile`, never a shell — the same rule
// orchestrator/deps.ts follows for `npm`. Arguments are passed as an array, so
// a path with a space or a quote in it is an argument rather than syntax.
//
// Nothing here is available to any agent. Decision LD-1 forbids native Bash for
// agents; every command in this pipeline is run by the orchestrator process.

import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { workspaceRoot } from "./workspace.js";

const execFileAsync = promisify(execFile);

/**
 * Identity for the snapshot commit, supplied per-invocation with `-c`.
 *
 * NOT written to the workspace's git config, and not relying on the machine
 * having a global `user.email`. A workspace created by `git init` on a machine
 * with no git identity configured cannot commit at all, and the rollback
 * guarantee would fail at exactly the moment it is needed. This is a
 * bookkeeping commit made by a process, so it says so.
 */
const COMMIT_IDENTITY = [
  "-c",
  "user.name=agent-pipeline orchestrator",
  "-c",
  "user.email=orchestrator@agent-pipeline.local",
];

async function git(cwd: string, args: readonly string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], { cwd, maxBuffer: 32 * 1024 * 1024 });
  return stdout.trim();
}

/** Why version control cannot be used here, or null when it can. */
export type VcsUnavailable = string | null;

/**
 * Whether `git` can actually be used against `root`.
 *
 * Both halves are checked because they fail independently: git may be absent
 * from PATH entirely, or present but pointed at a directory that
 * `ensureWorkspace`'s `git init` failed on (it warns and continues, so a
 * workspace with no `.git` is a reachable state rather than a hypothetical).
 */
export async function checkVcs(root: string): Promise<VcsUnavailable> {
  try {
    await git(root, ["--version"]);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `git could not be run: ${detail}`;
  }

  try {
    const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside !== "true") return `${root} is not inside a git work tree.`;
  } catch {
    return (
      `${root} is not a git repository. The workspace is normally git-initialised at bootstrap; ` +
      `if that failed, run "git init" there yourself.`
    );
  }

  // The repo must be the WORKSPACE's own, not an enclosing repository that
  // happens to contain it. Resetting a parent repo would be catastrophic, and
  // `git init` warning-and-continuing at bootstrap is exactly how a workspace
  // ends up resolving to somebody else's history.
  //
  // Compared as REAL paths, not as resolved ones. `git rev-parse` reports the
  // toplevel with symlinks already followed, so a workspace reached through a
  // symlinked path — `/var/...` on macOS, which is a link to `/private/var`,
  // and any home directory that is itself a link — would compare unequal to
  // its own repository and be refused. That was not hypothetical: it is what
  // this check did on the first run of the test harness.
  try {
    const top = await git(root, ["rev-parse", "--show-toplevel"]);
    if ((await realPathOrSelf(top)) !== (await realPathOrSelf(root))) {
      return (
        `${root} is not the root of its git repository — the enclosing repository is ${top}. ` +
        `Refusing to snapshot or reset a repository the workspace does not own.`
      );
    }
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return `git could not resolve the repository root of ${root}: ${detail}`;
  }

  return null;
}

/** realpath(p), falling back to a plain resolve when the path cannot be read. */
async function realPathOrSelf(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/** Whether the repository has any commit yet (a fresh `git init` has none). */
export async function hasCommits(root: string): Promise<boolean> {
  try {
    await git(root, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

export interface WorkspaceCommit {
  /** Full sha of the commit the workspace can be restored to. */
  sha: string;
  /**
   * True when this commit is the repository's FIRST — i.e. the workspace had
   * no history at all before the snapshot was taken. Recorded because it
   * changes what "restore" means (see restoreCommit) and because it is worth
   * saying out loud in the log.
   */
  isInitialCommit: boolean;
}

/**
 * Commits the current state of the workspace so it can be restored later.
 *
 * `--allow-empty` because there is very often nothing to commit: the previous
 * snapshot already captured everything, and a clean tree must still yield a
 * commit to reset back to. Without it, `git commit` exits non-zero on a clean
 * tree and the caller would have to guess whether that meant "nothing changed"
 * or "commit failed".
 *
 * THE EMPTY-REPO CASE is handled by construction rather than by a branch: a
 * freshly `git init`-ed workspace has no HEAD, and this commit becomes its
 * first. The caller therefore always has a sha to return to, including on the
 * very first repair ever run against a workspace. The one thing that differs
 * is reported as `isInitialCommit`.
 */
export async function snapshotCommit(root: string, message: string): Promise<WorkspaceCommit> {
  const isInitialCommit = !(await hasCommits(root));
  // -A so deletions are captured too: restoring must bring back a file the
  // agent removed, not merely revert one it edited. .gitignore keeps
  // node_modules/ and dist/ out (see ensureWorkspace).
  await git(root, ["add", "-A"]);
  await git(root, [...COMMIT_IDENTITY, "commit", "--allow-empty", "--quiet", "-m", message]);
  const sha = await git(root, ["rev-parse", "HEAD"]);
  return { sha, isInitialCommit };
}

/**
 * Restores the workspace to `commit`, discarding everything done since.
 *
 * Two commands, because `reset --hard` alone is not a rollback: it reverts
 * tracked files but leaves files the agent CREATED sitting on disk untracked,
 * and a "repair" that adds a new broken file would survive its own rejection.
 * `clean -fd` removes those. Deliberately WITHOUT `-x`, so ignored paths —
 * `node_modules/` above all — are left alone: they are not the agent's output,
 * and deleting an install the orchestrator paid for to undo an edit would be a
 * far worse outcome than the edit.
 */
export async function restoreCommit(root: string, commit: WorkspaceCommit): Promise<void> {
  await git(root, ["reset", "--hard", "--quiet", commit.sha]);
  await git(root, ["clean", "-fdq"]);
}

/** Convenience wrapper: everything above, scoped to the configured workspace. */
export function workspaceVcs(): {
  root: string;
  check: () => Promise<VcsUnavailable>;
  snapshot: (message: string) => Promise<WorkspaceCommit>;
  restore: (commit: WorkspaceCommit) => Promise<void>;
} {
  const root = workspaceRoot();
  return {
    root,
    check: () => checkVcs(root),
    snapshot: (message: string) => snapshotCommit(root, message),
    restore: (commit: WorkspaceCommit) => restoreCommit(root, commit),
  };
}
