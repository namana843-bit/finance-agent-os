// ============================================================================
// Finance Agent OS — Coding Agent Workspace (public entry point)
//
//   Desktop UI  →  /api/coding/*  →  CodingWorkspace
//                                     ├─ CodingProviderRegistry  (who can run)
//                                     ├─ CodingProjectStore      (where)
//                                     └─ CodingSessionManager    (what happened)
//
// Concrete provider knowledge stays in `src/cli/adapters`. This layer only
// knows the provider contract.
// ============================================================================

import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import { getCliManager } from "../core/runtime.js";
import { CodingProjectStore, defaultProjectStorePath } from "./projects.js";
import { CodingProviderRegistry } from "./providers.js";
import { CodingSessionManager } from "./sessions.js";

export interface CodingWorkspaceOptions {
  dataDir?: string;
  /** Restrict providers (useful for tests and closed deployments). */
  only?: string[];
}

export class CodingWorkspace {
  readonly providers: CodingProviderRegistry;
  readonly projects: CodingProjectStore;
  readonly sessions: CodingSessionManager;

  constructor(opts: CodingWorkspaceOptions = {}) {
    const dataDir = opts.dataDir ?? DATA_DIR;
    const cli = getCliManager();
    this.providers = new CodingProviderRegistry(
      cli,
      opts.only && opts.only.length > 0 ? { only: opts.only } : {},
    );
    this.projects = new CodingProjectStore(defaultProjectStorePath(dataDir));
    this.sessions = new CodingSessionManager({
      cli,
      providers: this.providers,
      projects: this.projects,
      storagePath: join(dataDir, "coding", "sessions.json"),
      worktreeRoot: join(dataDir, "coding", "worktrees"),
    });
  }
}

let workspaceInstance: CodingWorkspace | null = null;

/** Shared workspace instance (one per server process). */
export function getCodingWorkspace(): CodingWorkspace {
  if (!workspaceInstance) workspaceInstance = new CodingWorkspace();
  return workspaceInstance;
}

/** Test helper — installs a workspace built with custom options. */
export function setCodingWorkspace(workspace: CodingWorkspace): void {
  workspaceInstance = workspace;
}

/** Test helper — drops the shared instance. */
export function resetCodingWorkspace(): void {
  workspaceInstance = null;
}

export * from "./types.js";
export { CodingProviderRegistry, capabilitiesFromMetadata, statusFromValidation, PRIMARY_CODING_PROVIDERS } from "./providers.js";
export { CodingProjectStore, validateProjectPath, readProjectGit, readProjectDiff, defaultProjectStorePath } from "./projects.js";
export type { ProjectDiff, ProjectDiffFile } from "./projects.js";
export { CodingSessionManager, CodingSessionError } from "./sessions.js";
export {
  createSessionWorktree,
  removeSessionWorktree,
  listProjectWorktrees,
  isGitRepository,
} from "./worktrees.js";
export type { SessionWorktree } from "./worktrees.js";
export type { CreateSessionInput } from "./sessions.js";
export type { ProjectValidationOptions } from "./projects.js";
