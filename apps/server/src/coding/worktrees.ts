// ============================================================================
// Finance Agent OS — Coding Agent Workspace: isolated git worktrees
//
// Two agents editing one working tree can silently overwrite each other. When
// a project is a git repository, a session can therefore run in its own
// worktree (`git worktree add`) on its own branch. The main tree stays
// untouched until the user reviews and merges.
//
// Read-only style: this module only runs git with argument arrays, never a
// shell string, and never touches the user's branch.
// ============================================================================

import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface SessionWorktree {
  path: string;
  branch: string;
  baseRef: string;
}

export type WorktreeResult =
  | { ok: true; worktree: SessionWorktree }
  | { ok: false; error: string };

function runGit(cwd: string, args: string[], timeout = 20_000): Promise<{ ok: boolean; out: string; error: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        resolve({ ok: false, out: String(stdout ?? ""), error: String(stderr || err.message).trim() });
        return;
      }
      resolve({ ok: true, out: String(stdout ?? "").trim(), error: "" });
    });
  });
}

/** True when `path` is the root of a git working tree. */
export function isGitRepository(path: string): boolean {
  return existsSync(join(path, ".git"));
}

/**
 * Create an isolated worktree for one session.
 *
 * Fails (rather than falling back to the shared tree) when the project is not
 * a git repository, has no commit yet, or the branch/path already exists.
 */
export async function createSessionWorktree(opts: {
  projectPath: string;
  sessionId: string;
  /** Directory that holds worktrees; created if missing. */
  rootDir: string;
  /** Optional ref to branch from (defaults to HEAD). */
  baseRef?: string;
}): Promise<WorktreeResult> {
  if (!isGitRepository(opts.projectPath)) {
    return { ok: false, error: "the project is not a git repository, so an isolated worktree cannot be created" };
  }
  const head = await runGit(opts.projectPath, ["rev-parse", "--verify", "HEAD"]);
  if (!head.ok) {
    return {
      ok: false,
      error: "the repository has no commit yet; make an initial commit before using isolated worktrees",
    };
  }

  const safeId = opts.sessionId.replace(/[^a-zA-Z0-9._-]/g, "-");
  const branch = `coding/${safeId}`;
  const baseRef = opts.baseRef ?? "HEAD";
  const path = join(opts.rootDir, safeId);

  try {
    await mkdir(opts.rootDir, { recursive: true, mode: 0o700 });
  } catch (err) {
    return { ok: false, error: `could not create the worktree directory: ${err instanceof Error ? err.message : String(err)}` };
  }

  const existingBranch = await runGit(opts.projectPath, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`]);
  const addArgs = existingBranch.ok
    ? ["worktree", "add", path, branch]
    : ["worktree", "add", "-b", branch, path, baseRef];
  const added = await runGit(opts.projectPath, addArgs);
  if (!added.ok) {
    return { ok: false, error: `git worktree add failed: ${added.error || "unknown error"}` };
  }
  return { ok: true, worktree: { path, branch, baseRef } };
}

/**
 * Remove a session worktree. `force` is required by git when the worktree has
 * uncommitted changes, so callers must opt in explicitly.
 */
export async function removeSessionWorktree(opts: {
  projectPath: string;
  worktreePath: string;
  branch?: string;
  force?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  if (!isGitRepository(opts.projectPath)) return { ok: false, error: "the project is not a git repository" };
  const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), opts.worktreePath];
  const removed = await runGit(opts.projectPath, args);
  if (!removed.ok) {
    return { ok: false, error: removed.error || "git worktree remove failed" };
  }
  if (opts.force && opts.branch) {
    await runGit(opts.projectPath, ["branch", "-D", opts.branch]);
  }
  // git removes the directory itself; clean up leftovers best effort.
  await rm(opts.worktreePath, { recursive: true, force: true }).catch(() => undefined);
  return { ok: true };
}

/** List worktrees registered for a project (best effort). */
export async function listProjectWorktrees(projectPath: string): Promise<Array<{ path: string; branch: string }>> {
  if (!isGitRepository(projectPath)) return [];
  const result = await runGit(projectPath, ["worktree", "list", "--porcelain"]);
  if (!result.ok) return [];
  const entries: Array<{ path: string; branch: string }> = [];
  let currentPath = "";
  for (const line of result.out.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) currentPath = line.slice("worktree ".length).trim();
    else if (line.startsWith("branch ") && currentPath) {
      entries.push({ path: currentPath, branch: line.slice("branch ".length).trim().replace(/^refs\/heads\//, "") });
    }
  }
  return entries;
}
