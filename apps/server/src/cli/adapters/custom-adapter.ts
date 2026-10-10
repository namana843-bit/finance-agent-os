// ============================================================================
// Finance Agent OS — Custom CLI Adapter
// Declarative adapter for user-defined agent CLIs. Deliberately small: it
// covers the common argv/stdin one-shot case so the architecture supports
// custom CLIs without touching the core runtime.
//
// Example descriptor:
//   {
//     "id": "my-agent",
//     "name": "My Agent",
//     "executablePath": "/path/to/agent",
//     "workingDirectory": "/project",
//     "args": ["run", "{prompt}"]
//   }
// ============================================================================

import type { CliMetadata, CliTaskDelivery } from "../types.js";
import { CliAdapterBase } from "../adapter-base.js";

export interface CustomCliDescriptor {
  id: string;
  name: string;
  description?: string;
  /** Executable name (resolved via PATH) or absolute path. */
  executablePath: string;
  workingDirectory?: string;
  /** argv template — `{prompt}` / `{model}` placeholders supported. */
  args?: string[];
  env?: Record<string, string>;
  supportsStreaming?: boolean;
  supportsCancellation?: boolean;
  /** Default: argv substitution. Use "stdin" for CLIs that read stdin. */
  taskDelivery?: CliTaskDelivery;
  engineAliases?: string[];
  installHint?: string;
}

export class CustomCliAdapter extends CliAdapterBase {
  private readonly descriptor: CustomCliDescriptor;

  constructor(descriptor: CustomCliDescriptor) {
    const metadata: CliMetadata = {
      id: descriptor.id,
      name: descriptor.name,
      description: descriptor.description ?? "Custom CLI agent",
      executable: descriptor.executablePath,
      supportsStreaming: descriptor.supportsStreaming ?? true,
      supportsCancellation: descriptor.supportsCancellation ?? true,
      taskDelivery: descriptor.taskDelivery ?? "argv",
      defaultArgs:
        descriptor.args && descriptor.args.length > 0
          ? [...descriptor.args]
          : ["{prompt}"],
      engineAliases: descriptor.engineAliases ?? [descriptor.id],
      installHint: descriptor.installHint,
    };
    super(metadata);
    this.descriptor = descriptor;
  }

  /** Read-only copy of the descriptor (surfaced through `/api/cli/adapters`). */
  getDescriptor(): CustomCliDescriptor {
    return { ...this.descriptor, args: this.descriptor.args ? [...this.descriptor.args] : undefined };
  }

  /** Working directory declared by the descriptor (used as the session cwd). */
  defaultCwd(): string | undefined {
    return this.descriptor.workingDirectory;
  }

  /** Explicit environment from the descriptor, merged with session overrides. */
  override buildEnv(extra?: Record<string, string>): Record<string, string> {
    return { ...(this.descriptor.env ?? {}), ...(extra ?? {}) };
  }
}

export function createCustomCliAdapter(descriptor: CustomCliDescriptor): CustomCliAdapter {
  return new CustomCliAdapter(descriptor);
}
