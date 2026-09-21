import type {
  ChatRequest,
  LLMEvent,
  ModelInfo,
  ProviderHealth,
} from "@finance/shared";
import type { LLMProvider, LLMProviderOptions } from "../provider.js";
import { CliProvider } from "./cli-engine.js";

export interface AcpProviderOptions {
  id?: string;
  name?: string;
  command: string;
  args?: string[];
  cwd?: string;
}

export class AcpProvider implements LLMProvider {
  readonly id: string;
  readonly name: string;
  private readonly cliProvider: CliProvider;

  constructor(opts: AcpProviderOptions) {
    this.id = opts.id || `acp-${opts.command}`;
    this.name = opts.name || `ACP Agent (${opts.command})`;
    this.cliProvider = new CliProvider({
      id: this.id,
      name: this.name,
      command: opts.command,
      args: opts.args ?? ["--acp"],
      cwd: opts.cwd,
    });
  }

  supportsTools(): boolean {
    return true;
  }

  async healthCheck(): Promise<ProviderHealth> {
    return this.cliProvider.healthCheck();
  }

  async listModels(): Promise<ModelInfo[]> {
    return this.cliProvider.listModels();
  }

  async *chat(
    request: ChatRequest,
    opts?: LLMProviderOptions,
  ): AsyncIterable<LLMEvent> {
    yield* this.cliProvider.chat(request, opts);
  }
}
