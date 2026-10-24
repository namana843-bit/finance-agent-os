// ============================================================================
// Finance Agent OS — Coding Agent Workspace: provider registry
//
// Turns the configured CLI adapters into coding providers the desktop UI can
// render. Nothing here invents a capability: every flag is derived from
// adapter metadata or from an actual probe, and anything unknown is reported
// as explicitly unsupported with a reason.
//
// This is a *view* over `CliManager`, not a second adapter system. Sessions,
// process control and environment policy stay in `src/cli`.
// ============================================================================

import type { CliAdapter, CliManager, CliMetadata, CliValidationResult } from "../cli/index.js";
import {
  type Capability,
  type CapabilityResult,
  type CodingAuthState,
  type CodingCapabilityId,
  type CodingModel,
  type CodingProviderDescriptor,
  type CodingProviderStatus,
  unsupported,
} from "./types.js";

/** Provider ids the workspace is expected to surface first. */
export const PRIMARY_CODING_PROVIDERS = ["opencode", "claude", "gemini", "codex"] as const;

const AUTH_ERROR_PATTERN = /unauthori[sz]ed|not (?:logged|signed) in|login required|auth(?:entication)? (?:failed|required)|invalid (?:api[ _-]?key|token)|missing (?:api[ _-]?key|credential)/i;

function capability(supported: boolean, reason: string): Capability {
  return supported ? { supported: true } : { supported: false, reason };
}

/** Derive status from an installation probe. Never throws. */
export function statusFromValidation(result: CliValidationResult | null): CodingProviderStatus {
  if (!result) {
    return { installed: false, version: null, auth: "unknown", resolvedPath: null, checkedAt: Date.now() };
  }
  const auth: CodingAuthState = result.error && AUTH_ERROR_PATTERN.test(result.error)
    ? "unauthenticated"
    : "unknown";
  const status: CodingProviderStatus = {
    installed: result.ok,
    version: result.version,
    auth,
    resolvedPath: result.resolvedPath,
    checkedAt: result.checkedAt,
  };
  if (result.error) status.error = result.error;
  return status;
}

/**
 * Derive the capability map from adapter metadata.
 *
 * `metadata`-only derivation is intentional: a capability is only advertised
 * when the adapter actually declares the machinery for it.
 */
export function capabilitiesFromMetadata(meta: CliMetadata): Record<CodingCapabilityId, Capability> {
  const sessionModes = meta.sessionModes ?? ["one-shot"];
  const persistent = sessionModes.includes("persistent");
  const declaresModelFlag = meta.defaultArgs.some((arg) => arg === "--model" || arg === "-m")
    || /\{model\}/.test(meta.defaultArgs.join(" "));

  return {
    install_detection: capability(true, ""),
    version_probe: capability(true, ""),
    auth_check: capability(
      false,
      "the adapter exposes no non-invasive auth probe; an auth verdict only follows a failed task",
    ),
    model_selection: capability(
      declaresModelFlag,
      "the adapter does not declare a model flag, so the workspace cannot select a model",
    ),
    streaming: capability(meta.supportsStreaming, "the adapter does not stream output"),
    cancellation: capability(meta.supportsCancellation, "the adapter cannot cancel a running task"),
    session_resume: capability(
      false,
      "the adapter does not declare a resume mechanism",
    ),
    persistent_session: capability(
      persistent,
      "the adapter supports one-shot sessions only",
    ),
    tool_events: capability(
      meta.supportsStreaming && meta.taskDelivery !== "rpc",
      "the adapter does not emit structured tool events",
    ),
    permission_requests: capability(
      false,
      "the adapter exposes no interactive permission channel",
    ),
    file_diffs: capability(
      false,
      "no provider-specific diff stream; project-level git review is used instead",
    ),
    terminal_output: capability(true, ""),
  };
}

function toDescriptor(adapter: CliAdapter, status: CodingProviderStatus): CodingProviderDescriptor {
  const meta = adapter.getMetadata();
  const descriptor: CodingProviderDescriptor = {
    providerId: meta.id,
    adapterId: meta.id,
    name: meta.name,
    description: meta.description,
    executable: meta.executable,
    status,
    capabilities: capabilitiesFromMetadata(meta),
  };
  if (meta.installHint) descriptor.installHint = meta.installHint;
  if (meta.authHint) descriptor.authHint = meta.authHint;
  return descriptor;
}

export interface CodingProviderRegistryOptions {
  /** Restrict the registry to these provider ids (in this order). */
  only?: string[];
}

/**
 * Read-only registry of coding providers backed by the shared `CliManager`.
 */
export class CodingProviderRegistry {
  constructor(
    private readonly cli: CliManager,
    private readonly opts: CodingProviderRegistryOptions = {},
  ) {}

  /** Provider ids in display order: primary providers first, then the rest. */
  listIds(): string[] {
    const all = this.cli.listMetadata().map((meta) => meta.id);
    const only = this.opts.only;
    const filtered = only && only.length > 0 ? all.filter((id) => only.includes(id)) : all;
    const primary = PRIMARY_CODING_PROVIDERS.filter((id) => filtered.includes(id)) as string[];
    const rest = filtered.filter((id) => !primary.includes(id));
    return [...primary, ...rest];
  }

  has(providerId: string): boolean {
    return this.cli.has(providerId) && this.listIds().includes(providerId);
  }

  /**
   * Build descriptors for every provider.
   * `refresh` forces a fresh executable/version probe instead of the cache.
   */
  async describeAll(opts: { refresh?: boolean } = {}): Promise<CodingProviderDescriptor[]> {
    const ids = this.listIds();
    const results = await Promise.all(
      ids.map(async (id) => {
        const adapter = this.cli.get(id);
        if (!adapter) return null;
        const validation = await this.safeValidate(id, opts.refresh === true);
        return toDescriptor(adapter, statusFromValidation(validation));
      }),
    );
    return results.filter((entry): entry is CodingProviderDescriptor => entry !== null);
  }

  async describe(providerId: string, opts: { refresh?: boolean } = {}): Promise<CodingProviderDescriptor | null> {
    if (!this.has(providerId)) return null;
    const adapter = this.cli.get(providerId);
    if (!adapter) return null;
    const validation = await this.safeValidate(providerId, opts.refresh === true);
    return toDescriptor(adapter, statusFromValidation(validation));
  }

  /**
   * Model enumeration. No adapter currently publishes a static model list, so
   * this returns an explicit unsupported result rather than an invented list.
   */
  async listModels(providerId: string): Promise<CapabilityResult<CodingModel[]>> {
    const descriptor = await this.describe(providerId);
    if (!descriptor) return unsupported(`unknown coding provider '${providerId}'`);
    if (!descriptor.capabilities.model_selection.supported) {
      return unsupported(descriptor.capabilities.model_selection.reason);
    }
    return unsupported(
      `${descriptor.name} accepts a model flag but does not publish its model list; pass a model id directly`,
    );
  }

  private async safeValidate(id: string, force: boolean): Promise<CliValidationResult | null> {
    try {
      return await this.cli.validate(id, { force });
    } catch (err) {
      return {
        adapterId: id,
        ok: false,
        executable: this.cli.get(id)?.getMetadata().executable ?? "",
        resolvedPath: null,
        version: null,
        error: err instanceof Error ? err.message : String(err),
        checkedAt: Date.now(),
      };
    }
  }
}
