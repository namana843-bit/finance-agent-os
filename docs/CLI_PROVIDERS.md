# CLI Provider Support Matrix

One-shot integrations built on the shared Phase-2 foundation
(`apps/server/src/cli/`): every provider reuses `CliManager` sessions,
`process-runner.ts` spawning (argv/stdin only — never shell strings),
executable resolution, timeouts, output limits and cleanup. Provider
differences (flags, parsing, errors) live in `cli/adapters/`.

> Rule: an integration is complete only when a real adapter + mocked tests
> exist. A catalog entry alone does not count.

| Provider | Executable | Connection | Mode | Streaming | Tool events | Cancellation | Auth (reused locally) | Tests |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| OpenCode | `opencode` | `run --auto {prompt}` (+ daemon attach) | one-shot + persistent (daemon) | Yes (JSON-lines) | Yes (`tool_call`) | Yes | local opencode auth | `cli-adapters` + `cli-connection-contract` |
| Claude Code | `claude` | `-p {prompt} --output-format stream-json` | one-shot | Yes (stream-json) | Yes (`tool_use`) | Yes | `claude` sign-in / `ANTHROPIC_API_KEY` | `cli-providers` (5) |
| Codex CLI | `codex` | `exec --json {prompt}` | one-shot | Yes (JSONL) | Yes (`item.*`) | Yes | `codex` sign-in / `CODEX_API_KEY` / `~/.codex/auth.json` | `cli-providers` (4) |
| Gemini CLI | `gemini` | `-p {prompt} --output-format stream-json` | one-shot | Yes (JSONL) | Yes (`tool_use`) | Yes | `gemini` sign-in / `GEMINI_API_KEY` | `cli-providers` (4) |
| Cursor CLI | `agent` | `-p {prompt} --output-format text` | one-shot | Raw text only (no structured stream documented) | No (not claimed) | Yes | `agent` sign-in | `cli-providers` (3) |
| Cline CLI | `cline` | `--json "{prompt}"` | one-shot | Yes (NDJSON) | Partial (`ask` approvals) | Yes | `cline auth <provider>` | `cli-providers` (3) |
| Grok | — | Unsupported: xAI publishes no official CLI | — | — | — | — | — | — |

## Notes

- **Persistent ACP:** `agent acp` (Cursor, documented) is the first planned
  consumer of the shared `cli/acp-transport.ts` framing module (Content-Length
  JSON-RPC, mock-tested). It is not wired into managed sessions yet — the
  handshake is unverified against a live binary, so Cursor stays one-shot.
- **`--resume` / `-T` / `--continue` flags** reuse server-side session state
  but every task is still a short-lived process; they do not count as
  persistent mode in this matrix.
- Env overrides per provider: `CLAUDE_CLI_PATH`, `CODEX_CLI_PATH`,
  `GEMINI_CLI_PATH`, `CURSOR_AGENT_CLI_PATH`, `CLINE_CLI_PATH`,
  `OPENCODE_CLI_PATH`.
