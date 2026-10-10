import type { EngineConfig, ModelInfo, ProviderHealth } from "@finance/shared";
import type { LLMProvider } from "./provider.js";
import { AcpProvider } from "./providers/acp-engine.js";
import { CliProvider } from "./providers/cli-engine.js";
import { OllamaProvider } from "./providers/ollama.js";
import { OpenAICompatibleProvider } from "./providers/openai-compat.js";
import { OpenAIProvider } from "./providers/openai.js";
import { CliSessionManager, createCliSessionManager } from "./cli-session.js";
import type { CliManager } from "../cli/index.js";
import { getDefaultCliManager } from "../cli/index.js";

export class ProviderRegistry {
  private readonly providers = new Map<string, LLMProvider>();

  constructor() {
    this.registerDefaults();
  }

  private registerDefaults(): void {
    this.register(new OpenAIProvider());
    this.register(new OllamaProvider());
    this.register(new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:1234/v1" }));
    // CLI defaults come from the registered CLI adapters (registration layer),
    // so adding a new CLI never requires touching the engine registry.
    // Authoritative engine→provider→adapter mapping: provider `cli-<adapter>`
    // always invokes that adapter (`CliManager.findByExecutable`).
    const manager = getDefaultCliManager();
    for (const adapterId of ["opencode", "claude", "codex", "gemini"]) {
      const adapter = manager.get(adapterId);
      const meta = adapter?.getMetadata();
      if (!adapter || !meta) continue;
      this.register(
        new CliProvider({
          id: `cli-${meta.id}`,
          name: `${meta.name} CLI`,
          command: meta.executable,
          args: [...meta.defaultArgs],
          timeoutMs: 300000,
          cliManager: manager,
        }),
      );
    }
  }

  register(provider: LLMProvider): void {
    if (!provider || !provider.id) {
      throw new Error("Cannot register invalid provider without id");
    }
    this.providers.set(provider.id, provider);
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): LLMProvider | undefined {
    return this.providers.get(id);
  }

  has(id: string): boolean {
    return this.providers.has(id);
  }

  list(): LLMProvider[] {
    return Array.from(this.providers.values());
  }

  async listAllModels(): Promise<ModelInfo[]> {
    const results: ModelInfo[] = [];
    for (const provider of this.providers.values()) {
      try {
        const models = await provider.listModels();
        results.push(...models);
      } catch {
        // Skip provider failure
      }
    }
    return results;
  }

  async getHealth(): Promise<Record<string, ProviderHealth>> {
    const healthMap: Record<string, ProviderHealth> = {};
    for (const [id, provider] of this.providers.entries()) {
      try {
        healthMap[id] = await provider.healthCheck();
      } catch (err) {
        healthMap[id] = {
          providerId: id,
          status: "error",
          message: err instanceof Error ? err.message : String(err),
        };
      }
    }
    return healthMap;
  }
}

export class EngineManager {
  private readonly registry: ProviderRegistry;
  private readonly engineConfigs = new Map<string, EngineConfig>();
  private readonly cliSessionManager: CliSessionManager;
  private readonly cliManager: CliManager;

  constructor(
    registry: ProviderRegistry,
    cliSessionManager?: CliSessionManager,
    cliManager?: CliManager,
  ) {
    this.registry = registry;
    this.cliManager = cliManager ?? getDefaultCliManager();
    this.cliSessionManager =
      cliSessionManager ?? createCliSessionManager({ cliManager: this.cliManager });
    this.loadDefaultConfigs();
  }

  getCliSessionManager(): CliSessionManager {
    return this.cliSessionManager;
  }

  /** CLI manager backing every CLI engine resolution in this manager. */
  getCliManager(): CliManager {
    return this.cliManager;
  }

  private loadDefaultConfigs(): void {
    this.engineConfigs.set("openai-gpt4", {
      type: "api",
      provider: "openai",
      model: "gpt-4o",
    });
    this.engineConfigs.set("openrouter-claude", {
      type: "api",
      provider: "openrouter",
      model: "anthropic/claude-3.5-sonnet",
    });
    this.engineConfigs.set("ollama-local", {
      type: "api",
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen2.5-coder",
    });
    this.engineConfigs.set("opencode-cli", {
      type: "cli",
      provider: "cli",
      name: "OpenCode CLI",
      command: "opencode",
      args: ["run", "--auto", "{prompt}"],
    });
    for (const [id, name, command, args] of [
      ["claude", "Claude Code", "claude", ["-p", "{prompt}"]],
      ["codex", "Codex", "codex", ["exec", "{prompt}"]],
      ["gemini", "Gemini", "gemini", ["-p", "{prompt}"]],
    ] as Array<[string, string, string, string[]]>) {
      this.engineConfigs.set(id, { type: "cli", provider: "cli", name, command, args });
    }
    this.engineConfigs.set("opencode", {
      type: "cli",
      provider: "cli",
      name: "OpenCode",
      command: "opencode",
      args: ["run", "--auto", "{prompt}"],
    });
    this.engineConfigs.set("cli", {
      type: "cli",
      provider: "cli",
      name: "CLI Engine",
      command: "opencode",
      args: ["run", "--auto", "{prompt}"],
    });

    // Register default CLI providers with shared session manager
    this.registerCliProvider("cli-opencode", "OpenCode CLI", "opencode", ["run", "--auto", "{prompt}"], 300000);
    this.registerCliProvider("cli", "CLI Engine", "opencode", ["run", "--auto", "{prompt}"], 300000);
  }

  private registerCliProvider(id: string, name: string, command: string, args: string[], timeoutMs: number): void {
    this.registry.register(
      new CliProvider({
        id,
        name,
        command,
        args,
        timeoutMs,
        sessionManager: this.cliSessionManager,
      }),
    );
  }

  setEngineConfig(id: string, config: EngineConfig): void {
    this.engineConfigs.set(id, config);

    // Instantiate dynamic provider if config defines custom params
    if (config.type === "cli") {
      this.registry.register(
        new CliProvider({
          id,
          name: config.name || id,
          command: config.command,
          args: config.args,
          cwd: config.cwd,
          env: config.env,
          timeoutMs: (config as any).timeoutMs,
          sessionManager: this.cliSessionManager,
        }),
      );
    } else if (config.type === "acp") {
      this.registry.register(
        new AcpProvider({
          id,
          name: config.name || id,
          command: config.command,
          args: config.args,
          cwd: config.cwd,
        }),
      );
    } else if (config.provider === "openai-compatible") {
      this.registry.register(
        new OpenAICompatibleProvider({
          providerId: id,
          providerName: id,
          baseUrl: config.baseUrl,
          apiKeyEnv: config.apiKeyEnv,
          defaultModel: config.model,
        }),
      );
    }
  }

  getEngineConfig(id: string): EngineConfig | undefined {
    return this.engineConfigs.get(id);
  }

  listEngineConfigs(): Array<{ id: string; config: EngineConfig }> {
    return Array.from(this.engineConfigs.entries()).map(([id, config]) => ({
      id,
      config,
    }));
  }

  async getProviderForEngine(engineId: string): Promise<{ provider: LLMProvider; model?: string }> {
    const config = this.engineConfigs.get(engineId);
    if (config) {
      // Honor a user-pasted executable path for CLI engines (e.g. opencode-cli
      // → catalog "opencode" override) while keeping the engine's own args.
      if (config.type === "cli") {
        // An explicitly named provider (anything but the generic "cli")
        // always wins — e.g. tests registering a mock provider id.
        // (Read through `string` — the declared type is literally "cli".)
        const providerId: string = config.provider;
        if (providerId !== "cli") {
          const explicit =
            this.registry.get(providerId) ?? this.registry.get(engineId);
          if (explicit) {
            return { provider: explicit, model: (config as any).model };
          }
        } else {
          // Authoritative mapping: engine `claude` → provider `cli-claude`
          // (the registered adapter's provider), not the legacy `cli` fallback.
          const mapped = this.registry.get(`cli-${engineId}`) ?? this.registry.get(engineId);
          if (mapped) {
            return { provider: mapped, model: (config as any).model };
          }
        }
        const overridden = await this.resolveOverriddenCliProvider(
          engineId,
          config.args,
          config.name,
        );
        if (overridden) {
          return { provider: overridden, model: (config as any).model };
        }
      }
      const provider = this.registry.get(config.provider) || this.registry.get(engineId);
      if (provider) {
        return { provider, model: (config as any).model };
      }
      if (config.type === "api") {
        // An API-typed engine whose provider is not registered is
        // misconfigured — throw explicitly instead of falling through to CLI
        // substring matching and silently running the wrong backend.
        throw new Error(
          `No provider registered for engine '${engineId}' (needs API provider '${config.provider}')`,
        );
      }
    }

    // Catalog engine: build (and refresh) a CLI provider
    // from its effective command so an overridden executable path actually runs.
    const cliEngine = await this.resolveCliEngine(engineId);
    if (cliEngine) {
      return { provider: cliEngine };
    }

    // Direct fallback lookup by provider ID
    const directProvider = this.registry.get(engineId);
    if (directProvider) {
      return { provider: directProvider };
    }

    // Authoritative adapter routing: any engine id owned by a registered CLI
    // adapter resolves to that adapter's provider (`cli-<adapter>`), creating
    // it lazily so catalog ids work without an explicit engine config.
    const adapter = this.cliManager.findByEngineId(engineId);
    if (adapter) {
      const meta = adapter.getMetadata();
      const adapterProviderId = `cli-${meta.id}`;
      const existing = this.registry.get(adapterProviderId);
      if (existing) {
        return { provider: existing };
      }
      const created = new CliProvider({
        id: adapterProviderId,
        name: `${meta.name} CLI`,
        command: meta.executable,
        args: [...meta.defaultArgs],
        timeoutMs: 300000,
        sessionManager: this.cliSessionManager,
        cliManager: this.cliManager,
      });
      this.registry.register(created);
      return { provider: created };
    }

    if (engineId.includes("cli")) {
      const cliProvider = this.registry.get("cli") || Array.from(this.registry.list()).find((p) => p instanceof CliProvider);
      if (cliProvider) {
        return { provider: cliProvider };
      }
    }

    throw new Error(`No provider registered for engine '${engineId}'`);
  }

  /** Normalized candidate ids for an engine (opencode-cli → opencode). */
  private engineIdCandidates(engineId: string): string[] {
    const ids = [engineId];
    if (engineId.endsWith("-cli")) ids.push(engineId.slice(0, -4));
    if (engineId.startsWith("cli-")) ids.push(engineId.slice(4));
    return ids;
  }

  /** Resolve a catalog CLI engine id to a CliProvider using the
   *  user's overridden command path (engines.json), registering it for reuse. */
  private async resolveCliEngine(engineId: string): Promise<LLMProvider | undefined> {
    try {
      const { findEngineEntry, loadEngineOverrides, resolveEngineCommand } = await import("./engines.js");
      const entry = await findEngineEntry(engineId);
      if (!entry || entry.kind !== "cli") return undefined;
      const overrides = await loadEngineOverrides();
      const command = resolveEngineCommand(entry, overrides);
      if (!command || command.trim() === "") return undefined;
      return this.registerCliEngineProvider(engineId, entry.name, command.trim(), entry.suggestedArgs);
    } catch {
      return undefined;
    }
  }

  /** Only returns a provider when the user explicitly pasted an override path
   *  for one of the engine's catalog ids — preserves default behavior otherwise. */
  private async resolveOverriddenCliProvider(
    engineId: string,
    args: string[] | undefined,
    name?: string,
  ): Promise<LLMProvider | undefined> {
    try {
      const { findEngineEntry, loadEngineOverrides } = await import("./engines.js");
      const overrides = await loadEngineOverrides();
      for (const candidate of this.engineIdCandidates(engineId)) {
        const command = overrides[candidate];
        if (typeof command !== "string" || command.trim() === "") continue;
        const entry = await findEngineEntry(candidate);
        return this.registerCliEngineProvider(
          engineId,
          name ?? entry?.name ?? engineId,
          command.trim(),
          args ?? entry?.suggestedArgs,
        );
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  private registerCliEngineProvider(
    id: string,
    name: string,
    command: string,
    args: string[] | undefined,
  ): LLMProvider {
    const provider = new CliProvider({
      id,
      name,
      command,
      args,
      timeoutMs: 300000,
      sessionManager: this.cliSessionManager,
      cliManager: this.cliManager,
    });
    this.registry.register(provider);
    return provider;
  }
}
