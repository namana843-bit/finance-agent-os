/**
 * Static provider catalog.
 *
 * This is a *table*, not a second registry: providers are still registered in
 * the single existing `ProviderRegistry`. The catalog supplies the connection
 * defaults (base URL, credential env name, capability claims) that the
 * registry and the desktop UI need before any connection exists.
 *
 * Capability claims are conservative on purpose. `tools` is only true where
 * the API accepts tool definitions for the models this preset serves, and
 * `streaming` only where the wire protocol streams tokens.
 */
import type { LLMProvider } from "./provider.js";
import { AnthropicProvider } from "./providers/anthropic.js";
import { GeminiProvider } from "./providers/gemini.js";
import { OpenAIProvider } from "./providers/openai.js";
import { OpenAICompatibleProvider } from "./providers/openai-compat.js";
import { OllamaProvider } from "./providers/ollama.js";

export type ProviderFamily =
  | "openai"
  | "anthropic"
  | "gemini"
  | "openai-compatible"
  | "ollama"
  | "cli";

export interface ProviderCapabilities {
  streaming: boolean;
  tools: boolean;
  reasoning: boolean;
}

export interface ProviderPreset {
  id: string;
  name: string;
  kind: "api" | "cli";
  family: ProviderFamily;
  baseUrl?: string;
  /** Env var that holds the credential. The value never leaves the server. */
  apiKeyEnv?: string;
  keyRequired: boolean;
  defaultModel?: string;
  docsUrl?: string;
  capabilities: ProviderCapabilities;
  /** Optional allow-list for gateway endpoints that expose many vendors. */
  modelFilter?: RegExp;
}

export const API_PRESETS: ProviderPreset[] = [
  {
    id: "openai",
    name: "OpenAI",
    kind: "api",
    family: "openai",
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    keyRequired: true,
    defaultModel: "gpt-4o",
    docsUrl: "https://platform.openai.com/api-keys",
    capabilities: { streaming: true, tools: true, reasoning: true },
  },
  {
    id: "anthropic",
    name: "Anthropic Claude",
    kind: "api",
    family: "anthropic",
    baseUrl: "https://api.anthropic.com",
    apiKeyEnv: "ANTHROPIC_API_KEY",
    keyRequired: true,
    defaultModel: "claude-sonnet-4-20250514",
    docsUrl: "https://console.anthropic.com/settings/keys",
    capabilities: { streaming: true, tools: true, reasoning: true },
  },
  {
    id: "gemini",
    name: "Google Gemini",
    kind: "api",
    family: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKeyEnv: "GEMINI_API_KEY",
    keyRequired: true,
    defaultModel: "gemini-2.0-flash",
    docsUrl: "https://aistudio.google.com/apikey",
    capabilities: { streaming: true, tools: true, reasoning: true },
  },
  {
    id: "xai",
    name: "xAI Grok",
    kind: "api",
    family: "openai-compatible",
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnv: "XAI_API_KEY",
    keyRequired: true,
    defaultModel: "grok-2-latest",
    docsUrl: "https://console.x.ai",
    capabilities: { streaming: true, tools: true, reasoning: false },
    modelFilter: /grok/i,
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    kind: "api",
    family: "openai-compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnv: "OPENROUTER_API_KEY",
    keyRequired: true,
    defaultModel: "anthropic/claude-sonnet-4",
    docsUrl: "https://openrouter.ai/keys",
    capabilities: { streaming: true, tools: true, reasoning: true },
  },
  {
    id: "ollama",
    name: "Ollama",
    kind: "api",
    family: "ollama",
    baseUrl: "http://127.0.0.1:11434",
    keyRequired: false,
    defaultModel: "qwen2.5-coder",
    docsUrl: "https://ollama.com/download",
    capabilities: { streaming: true, tools: true, reasoning: false },
  },
  {
    id: "lmstudio",
    name: "LM Studio",
    kind: "api",
    family: "openai-compatible",
    baseUrl: "http://127.0.0.1:1234/v1",
    apiKeyEnv: "LMSTUDIO_API_KEY",
    keyRequired: false,
    defaultModel: "local-model",
    docsUrl: "https://lmstudio.ai",
    // Local OpenAI servers accept tool definitions; whether the loaded model
    // honours them is a model-level question the health panel reports.
    capabilities: { streaming: true, tools: true, reasoning: false },
  },
  {
    id: "vllm",
    name: "vLLM",
    kind: "api",
    family: "openai-compatible",
    baseUrl: "http://127.0.0.1:8000/v1",
    apiKeyEnv: "VLLM_API_KEY",
    keyRequired: false,
    defaultModel: "local-model",
    docsUrl: "https://docs.vllm.ai",
    capabilities: { streaming: true, tools: true, reasoning: false },
  },
];

export function getPreset(id: string): ProviderPreset | undefined {
  return API_PRESETS.find((preset) => preset.id === id);
}

export interface BuildProviderOptions {
  /** Provider id to register this instance under (defaults to the preset id). */
  providerId?: string;
  providerName?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  defaultModel?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Instantiate the concrete provider for a preset. The credential is read from
 * the environment by name; it is never passed through this factory as a value.
 */
export function buildProvider(
  preset: ProviderPreset,
  opts: BuildProviderOptions = {},
): LLMProvider {
  const baseUrl = opts.baseUrl ?? preset.baseUrl;
  const apiKeyEnv = opts.apiKeyEnv ?? preset.apiKeyEnv;
  const common = {
    providerId: opts.providerId ?? preset.id,
    providerName: opts.providerName ?? preset.name,
    baseUrl,
    apiKeyEnv,
    defaultModel: opts.defaultModel ?? preset.defaultModel,
    fetchImpl: opts.fetchImpl,
    timeoutMs: opts.timeoutMs,
  };

  switch (preset.family) {
    case "anthropic":
      return new AnthropicProvider(common);
    case "gemini":
      return new GeminiProvider(common);
    case "ollama":
      return new OllamaProvider({
        baseUrl,
        defaultModel: common.defaultModel,
        fetchImpl: opts.fetchImpl,
      });
    case "openai":
      return new OpenAIProvider({
        baseUrl,
        apiKeyEnv,
        defaultModel: common.defaultModel,
        fetchImpl: opts.fetchImpl,
      });
    case "openai-compatible":
    default:
      return new OpenAICompatibleProvider({
        ...common,
        supportsTools: preset.capabilities.tools,
        modelFilter: preset.modelFilter,
      });
  }
}

/** Public (secret-free) view of a preset for the desktop UI. */
export function presetSummary(preset: ProviderPreset) {
  return {
    id: preset.id,
    name: preset.name,
    kind: preset.kind,
    family: preset.family,
    baseUrl: preset.baseUrl,
    apiKeyEnv: preset.apiKeyEnv,
    keyRequired: preset.keyRequired,
    defaultModel: preset.defaultModel,
    docsUrl: preset.docsUrl,
    capabilities: preset.capabilities,
  };
}
