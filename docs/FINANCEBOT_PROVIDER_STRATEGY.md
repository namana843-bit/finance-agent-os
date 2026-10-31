# FinanceBot Provider Strategy

FinanceBot uses the repository's existing backend provider abstraction. The desktop UI selects a registered engine/model; it never calls model vendors directly.

## Provider support plan

| Provider family | Integration route | Status in current foundation | FinanceBot use |
| --- | --- | --- | --- |
| OpenAI | Native server provider | Existing | General Supervisor, structured reasoning and tool calls |
| OpenRouter | OpenAI-compatible gateway | Engine configuration path exists; verify endpoint/key configuration | Per-agent model choice across supported vendors |
| xAI | OpenAI-compatible endpoint | Requires configured compatible engine and credentials | Research / synthesis model option |
| Google Gemini | Compatible endpoint or registered CLI adapter | Requires configured compatible engine or CLI | Long-context research and multimodal analysis |
| Anthropic Claude | Claude Code CLI today; native Messages adapter is a separate integration | CLI adapter ecosystem exists | Quant review and independent critique |
| Ollama | Native local provider | Existing | Local/private models and offline development |
| LM Studio / vLLM | OpenAI-compatible endpoint | Existing compatible-provider pattern | Local or self-hosted inference |
| Codex / Cline / Gemini CLI | Registered CLI adapters | Existing adapter ecosystem | Optional coding/data-workflow agents, not a substitute for finance tool permissions |

A provider being listed here does not mean it is configured or connected in a given installation. The UI must reflect actual backend health and capabilities.

## Connection model

A provider connection has: provider ID, display name, endpoint (if applicable), credential reference, enabled state, default model, capability metadata, created/updated timestamps, and last health-check result.

Secret material is stored only in the Electron main process via the OS credential store (or injected into the server environment for headless use). Persist only a secret reference and masked status. Never expose raw keys in JSON responses, logs, renderer storage, agent context, or export files.

## Model routing

Each agent profile chooses an engine ID and optional model ID. The backend resolves the engine through `EngineManager`, checks provider health and required capabilities, and rejects unsupported tool/streaming combinations before starting a run.

Suggested defaults are user-configurable; do not hardcode vendor rankings or claim that one model is best for finance. Keep provider/model choice separate from tool permissions and execution permissions.
