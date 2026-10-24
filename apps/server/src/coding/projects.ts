// ============================================================================
// Finance Agent OS — Coding Agent Workspace: projects
//
// A project is the sandbox boundary for a coding session. Nothing else in the
// workspace may widen it: every session records the validated absolute path it
// was started with, and provider processes are launched with that path as cwd.
//
// Path validation is deliberately conservative. It refuses relative paths,
// traversal segments, filesystem roots, OS/system directories, and credential
// stores. Optional `allowedRoots` narrows it further for closed deployments.
// ============================================================================

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { writeFileAtomic } from "../atomic.js";
import type { CodingProject, CodingProjectGit, ProjectPathValidation } from "./types.js";

export interface ProjectValidationOptions {
  /** Allowed roots; when set, a project must live inside one of them. */
  allowedRoots?: string[];
  /** Override home dir (tests). */
  homeDir?: string;
  /** Override data dir so the app's own state is never a project (tests). */
  dataDir?: string;
}

/** Directory names that hold credentials — never projects. */
const BLOCKED_DIR_NAMES = new Set([".ssh", ".aws", ".gnupg", ".kube", ".docker", ".password-store", ".finance-agent"]);

/** Absolute OS/system prefixes that must never become a project root. */
function systemPrefixes(): string[] {
  const prefixes: string[] = [];
  const env = process.env;
  for (const key of ["WINDIR", "SystemRoot", "ProgramFiles", "ProgramFiles(x86)", "ProgramData"]) {
    const value = env[key];
    if (value && value.trim().length > 0) prefixes.push(value);
  }
  prefixes.push("/etc", "/usr", "/bin", "/sbin", "/lib", "/boot", "/var", "/System", "/Library", "/private/etc");
  return prefixes;
}

const MAX_PROJECT_PATH_CHARS = 1_024;

function isInside(child: string, parent: string): boolean {
  const normalizedChild = normalize(child).toLowerCase();
  const normalizedParent = normalize(parent).toLowerCase();
  if (normalizedChild === normalizedParent) return true;
  const withSep = normalizedParent.endsWith(sep) ? normalizedParent : `${normalizedParent}${sep}`;
  return normalizedChild.startsWith(withSep);
}

function isFilesystemRoot(path: string): boolean {
  const normalized = normalize(path);
  const parsedRoot = resolve("/");
  // Windows: "C:\" / "C:" ; POSIX: "/"
  if (normalized === parsedRoot) return true;
  if (/^[A-Za-z]:[\\/]?$/.test(normalized)) return true;
  if (normalized === sep) return true;
  return normalized.replace(/[\\/]+$/, "").length === 0;
}

/**
 * Validate a user-supplied project path.
 *
 * Never throws. Returns the normalized absolute path on success, or a typed
 * error code the UI can turn into actionable guidance.
 */
export async function validateProjectPath(
  input: unknown,
  opts: ProjectValidationOptions = {},
): Promise<ProjectPathValidation> {
  if (typeof input !== "string") {
    return { ok: false, code: "not_absolute", error: "project path must be a string" };
  }
  const raw = input.trim();
  if (raw.length === 0) {
    return { ok: false, code: "not_absolute", error: "project path is empty" };
  }
  if (raw.length > MAX_PROJECT_PATH_CHARS) {
    return { ok: false, code: "too_long", error: `project path allows at most ${MAX_PROJECT_PATH_CHARS} characters` };
  }
  if (raw.includes("\0")) {
    return { ok: false, code: "not_absolute", error: "project path contains a null byte" };
  }
  // Reject traversal before normalizing so "..\" is reported, not silently absorbed.
  const segments = raw.split(/[\\/]+/);
  if (segments.some((segment) => segment === "..")) {
    return { ok: false, code: "traversal", error: "project path must not contain '..' segments" };
  }
  if (!isAbsolute(raw)) {
    return { ok: false, code: "not_absolute", error: "project path must be absolute" };
  }

  const normalized = normalize(raw).replace(/[\\/]+$/, "") || normalize(raw);
  if (isFilesystemRoot(normalized)) {
    return { ok: false, code: "blocked_location", error: "a filesystem root cannot be a project" };
  }

  const home = opts.homeDir ?? homedir();
  if (normalize(normalized).toLowerCase() === normalize(home).toLowerCase()) {
    return { ok: false, code: "blocked_location", error: "the home directory cannot be a project" };
  }
  const blockedSegment = segments.find((segment) => BLOCKED_DIR_NAMES.has(segment.toLowerCase()));
  if (blockedSegment) {
    return {
      ok: false,
      code: "blocked_location",
      error: `'${blockedSegment}' is a protected location and cannot be a project`,
    };
  }
  for (const prefix of systemPrefixes()) {
    if (isInside(normalized, prefix)) {
      return {
        ok: false,
        code: "blocked_location",
        error: "operating-system directories cannot be projects",
      };
    }
  }
  if (segments.some((segment) => segment.toLowerCase() === "node_modules")) {
    return {
      ok: false,
      code: "blocked_location",
      error: "a node_modules directory cannot be a project root",
    };
  }
  if (opts.dataDir && isInside(normalized, opts.dataDir)) {
    return { ok: false, code: "blocked_location", error: "the app's own data directory cannot be a project" };
  }

  let real = normalized;
  try {
    real = await realpath(normalized);
  } catch {
    // realpath fails for missing paths too — the stat below reports it.
  }

  try {
    const info = await stat(real);
    if (!info.isDirectory()) {
      return { ok: false, code: "not_a_directory", error: "project path is not a directory" };
    }
  } catch {
    return { ok: false, code: "missing", error: "project path does not exist" };
  }

  if (opts.allowedRoots && opts.allowedRoots.length > 0) {
    const insideAllowed = opts.allowedRoots.some((root) => isInside(real, root));
    if (!insideAllowed) {
      return {
        ok: false,
        code: "outside_allowed_root",
        error: "project path is outside the configured project roots",
      };
    }
  }

  return { ok: true, path: real };
}

/** Best-effort git metadata for a project directory. Never throws. */
export async function readProjectGit(path: string): Promise<CodingProjectGit> {
  const gitPath = join(path, ".git");
  if (!existsSync(gitPath)) return { isRepo: false };

  const run = (args: string[]): Promise<string | null> =>
    new Promise((resolvePromise) => {
      execFile("git", args, { cwd: path, timeout: 4_000, windowsHide: true }, (err, stdout) => {
        resolvePromise(err ? null : String(stdout).trim());
      });
    });

  const branch = (await run(["rev-parse", "--abbrev-ref", "HEAD"])) || undefined;
  const statusRaw = await run(["status", "--porcelain"]);
  const git: CodingProjectGit = { isRepo: true };
  if (branch) git.branch = branch;
  if (statusRaw !== null) git.dirty = statusRaw.length > 0;
  return git;
}

export interface ProjectDiffFile {
  /** Path as git reports it (rename notation preserved). */
  path: string;
  /** Two-letter porcelain status (M, A, D, R, ?? …). */
  status: string;
}

export interface ProjectDiff {
  isRepo: boolean;
  files: ProjectDiffFile[];
  stat: string;
  /** Unified diff, truncated to `maxChars`. */
  patch: string;
  truncated: boolean;
  error?: string;
}

/**
 * Read the uncommitted working-tree changes of a project.
 *
 * Read-only and bounded: `git status --porcelain`, `git diff --stat` and a
 * size-capped `git diff`. Never throws — a missing git binary or a non-repo
 * project reports `isRepo: false`.
 */
export async function readProjectDiff(
  path: string,
  opts: { maxChars?: number } = {},
): Promise<ProjectDiff> {
  const maxChars = opts.maxChars ?? 60_000;
  const gitPath = join(path, ".git");
  if (!existsSync(gitPath)) {
    return { isRepo: false, files: [], stat: "", patch: "", truncated: false };
  }

  const run = (args: string[], timeout = 8_000): Promise<{ ok: boolean; out: string; error?: string }> =>
    new Promise((resolvePromise) => {
      execFile(
        "git",
        args,
        { cwd: path, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 },
        (err, stdout, stderr) => {
          if (err) {
            resolvePromise({ ok: false, out: String(stdout ?? ""), error: String(stderr || err.message).trim() });
            return;
          }
          resolvePromise({ ok: true, out: String(stdout ?? "") });
        },
      );
    });

  const status = await run(["status", "--porcelain"]);
  if (!status.ok) {
    return { isRepo: true, files: [], stat: "", patch: "", truncated: false, error: status.error };
  }
  const files: ProjectDiffFile[] = status.out
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 3)
    .map((line) => ({ status: line.slice(0, 2).trim(), path: line.slice(3) }))
    .slice(0, 500);

  const statResult = await run(["diff", "--stat"]);
  const patchResult = await run(["diff", "--no-color", "--unified=3"]);
  const rawPatch = patchResult.out;
  const truncated = rawPatch.length > maxChars;
  return {
    isRepo: true,
    files,
    stat: statResult.out.trim(),
    patch: truncated ? `${rawPatch.slice(0, maxChars)}\n… diff truncated …` : rawPatch,
    truncated,
    ...(patchResult.error ? { error: patchResult.error } : {}),
  };
}

interface PersistedProjectFile {
  version: 1;
  projects: CodingProject[];
}

/**
 * Persistent registry of projects the user has added.
 * Stored under `<dataDir>/coding/projects.json` with 0600 permissions.
 */
export class CodingProjectStore {
  private projects = new Map<string, CodingProject>();
  private loaded = false;

  constructor(private readonly filePath: string) {}

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!existsSync(this.filePath)) return;
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<PersistedProjectFile>;
      if (!Array.isArray(parsed.projects)) return;
      for (const project of parsed.projects) {
        if (
          project
          && typeof project.id === "string"
          && typeof project.path === "string"
          && typeof project.name === "string"
        ) {
          this.projects.set(project.id, project);
        }
      }
    } catch {
      // A corrupt registry must not take the server down; start empty.
    }
  }

  private persist(): void {
    const payload: PersistedProjectFile = { version: 1, projects: [...this.projects.values()] };
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 });
      writeFileAtomic(this.filePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    } catch {
      // Persistence is best effort; the in-memory registry stays authoritative.
    }
  }

  list(): CodingProject[] {
    this.load();
    return [...this.projects.values()].sort((a, b) => b.lastOpenedAt - a.lastOpenedAt);
  }

  get(id: string): CodingProject | undefined {
    this.load();
    return this.projects.get(id);
  }

  findByPath(path: string): CodingProject | undefined {
    this.load();
    const needle = normalize(path).toLowerCase();
    return [...this.projects.values()].find((project) => normalize(project.path).toLowerCase() === needle);
  }

  /** Add (or reuse) a project for a validated absolute path. */
  add(path: string, git?: CodingProjectGit): CodingProject {
    this.load();
    const existing = this.findByPath(path);
    const now = Date.now();
    if (existing) {
      const updated: CodingProject = { ...existing, lastOpenedAt: now, ...(git ? { git } : {}) };
      this.projects.set(updated.id, updated);
      this.persist();
      return updated;
    }
    const project: CodingProject = {
      id: `prj-${randomUUID().slice(0, 8)}`,
      name: basename(path) || path,
      path,
      createdAt: now,
      lastOpenedAt: now,
      ...(git ? { git } : {}),
    };
    this.projects.set(project.id, project);
    this.persist();
    return project;
  }

  touch(id: string): CodingProject | undefined {
    this.load();
    const project = this.projects.get(id);
    if (!project) return undefined;
    const updated = { ...project, lastOpenedAt: Date.now() };
    this.projects.set(id, updated);
    this.persist();
    return updated;
  }

  remove(id: string): boolean {
    this.load();
    const had = this.projects.delete(id);
    if (had) this.persist();
    return had;
  }
}

export function defaultProjectStorePath(dataDir: string): string {
  return join(dataDir, "coding", "projects.json");
}
