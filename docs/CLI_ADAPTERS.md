# Finance Agent OS — Generic CLI Adapter Layer

> Implementation of the CLI adapter refactor. The full, code-linked overview lives in
> `apps/server/src/cli/README.md` (start there); this document records the
> pre-refactor assessment and the architecture contract.

---

## 1. Pre-refactor assessment (current-state snapshot)

**Repo layout:** pnpm monorepo — `apps/server` (Fastify :4132, TypeScript ESM strict, vitest),
`apps/dashboard` (Vite + React 18 + TailwindCSS + Electron), `packages/core`
(`FinanceRuntime` + `TypedEventBus`), `packages/shared` (domain/event types).

### 1.1 Where OpenCode-specific code lived (13 files, listed below)

| Area | File | OpenCode-specific content |
| ---- | ---- | -------------------------- |
| Gateway | `apps/server/src/gateway/opencode-cli-gateway.ts` | path candidate table, `OPENCODE_CLI_PATH`, command allowlist, `opencode.*` events, permissioned `execFile` run, `npx` fallback |
| Gateway | `apps/server/src/gateway/opencode-daemon.ts` | `opencode serve --port 4096 --pure` spawn + readiness poll + static singleton |
| LLM | `apps/server/src/llm/cli-session.ts` | 3 `command.includes("opencode")` branches: `--agent`, `--attach`/`--pure`, persistent mode |
| LLM | `apps/server/src/llm/providers/cli-engine.ts` | `isOpencode` splices `--agent/--model` after `run` |
| LLM | `apps/server/src/llm/registry.ts` | hard-coded `cli-opencode` default provider; `engineId.includes("opencode")` fallback |
| LLM | `apps/server/src/llm/cli-resolver.ts` | `OPENCODE_CLI_PATH` special case + `.opencode/bin` candidates |
| LLM | `apps/server/src/llm/engines.ts` | `opencode` entries in `KNOWN_ENGINES`/`ENGINE_CATALOG` (detection itself already generic for 12 CLIs) |
| Tools | `tools/opencode.ts`, `tools/finance-tools.ts` | `opencode_run` tool → gateway via string service id `"opencode-gateway"` |
| Runtime | `core/runtime.ts` | imports `OpencodeCliGateway` + `OpencodeDaemonManager`, `OPENCODE_GATEWAY` service, daemon URL wiring |
| API | `core/server.ts` | `/api/opencode/*` endpoints, `opencode.` publish denylist |
| Chat/agents | `chat/bots.ts`, `llm/agent-runtime.ts` | default data hard-codes `command: "opencode"` / `engine: "opencode-cli"` |

### 1.2 How CLI processes were started (4 independent spawn sites)

1. `opencode-cli-gateway.run()` — `execFile`, allowlisted commands, no shell, 30s timeout, 2MB buffer, `npx` fallback.
2. `opencode-daemon.start()` — `spawn opencode serve`, shell only for `.cmd/.ps1/.bat` wrappers, 15x200ms readiness poll.
3. `llm/cli-session.ts` — `spawn` one-shot (`--attach/--pure` with daemon) + persistent daemon-attach mode; argv `{prompt}` substitution + `stdin` write; abort via `AbortSignal`.
4. `llm/cli-driver.ts` — `execFile`, no shell, `{prompt}`/`{model}` templates, 30s timeout.

### 1.3 How tasks / streams flowed

- **Tasks:** argv template substitution (`{prompt}`, `{model}`) plus a `prompt + "\n"` `stdin` write in `cli-session.ts`. No adapter seam — a new CLI needed edits in `cli-session` + `cli-engine` + `registry` + `engines`.
- **Events:** raw `stdout` → line-split → JSON probe (`tool_call`, `delta`/`content`/`text`) → otherwise text delta. The parser was **copied 3 times**. `stderr` was discarded.
- **Desktop ↔ server:** REST + SSE (`/api/events`); the engine catalogue was already backend-driven; no OpenCode literal existed in dashboard code.

### 1.4 Duplication and tight coupling found

1. OpenCode path tables duplicated (gateway candidates vs resolver candidates).
2. `isOpencode` heuristics in 3 modules + `engineId.includes("opencode")` in the registry.
3. Stdout JSON parser duplicated 3 times.
4. The composition root imported OpenCode classes directly.
5. Daemon lifecycle hidden inside a gateway wrapper; session manager pulled its URL from a static singleton.
6. The security policy (allowlist + metachar rejection + no-shell) existed only in the gateway and had to **not be weakened** by the refactor.

---

## 2. Target architecture (what was implemented)

```text
Desktop UI ── REST /api/cli/* + SSE cli.* ──► Fastify (:4132)
                                                  │
                                            CLI Manager
                                      (register · get · list · validate
                                       start · sendTask · streamEvents · stop)
                                                  │
                                        CLI Adapter Interface
                             ┌────────────────────┼──────────────────────┐
                       OpenCodeAdapter      CustomCliAdapter      (future:
                       (full migration)     (descriptor-driven)   ClaudeCode /
                                                                  Codex / Gemini)
```

Design rules:

- The core runtime depends on `CliManager` + the `CliAdapter` interface only. The
  **only** file that names concrete adapters is `apps/server/src/cli/index.ts`.
- OpenCode-specific behaviour (executable detection, argv, protocol parsing,
  daemon ownership, validation) lives solely under `apps/server/src/cli/adapters/`.
- Events are normalized once (`session_started`, `output`, `tool_activity`,
  `status_changed`, `error`, `session_finished`, `session_failed`) and published
  as `cli.<type>`; adapters never emit UI-facing events of their own.
- The permissioned OpenCode gateway (`/api/opencode/*`, allowlist, metachar
  rejection, `opencode.*` events) is **preserved exactly** and now sources its
  discovery data from the adapter layer instead of duplicating it.

---

## 3. Migration map (which files changed and why)

| Change | Files | Why |
| ------ | ----- | --- |
| New CLI layer | `apps/server/src/cli/` (types, resolver, parsing, adapter-base, process-runner, cli-manager, index, README) | generic contract + manager + safe spawn (file map in `cli/README.md`) |
| OpenCode containment | `cli/adapters/` (opencode-paths, opencode-adapter, opencode-daemon, custom-adapter) | single home for OpenCode discovery/protocol/process logic + daemon ownership + custom CLIs |
| Path duplication removed | `gateway/opencode-cli-gateway.ts` | allowlist/probe/candidates now from the adapter layer; events, stats, gating, exports unchanged |
| Legacy import shims | `llm/cli-resolver.ts`, `gateway/opencode-daemon.ts` | re-export new locations; old import paths keep working |
| Hook-driven sessions | `llm/cli-session.ts` | `isOpencode` branches replaced by `CliAdapterHooks`; fallback behaviour identical without an adapter |
| Hook-driven provider | `llm/providers/cli-engine.ts` | `--agent/--model` splice delegated to `adapter.decorateTaskArgs` |
| Engine registry | `llm/registry.ts` | `cli-opencode` default built from adapter metadata; `CliManager.findByEngineId()` (called by `EngineManager`) replaces the opencode special case |
| Composition root | `core/runtime.ts` | new `cli-manager` service + `getCliManager()`; gateway uses the adapter-owned daemon |
| API | `core/server.ts` | `/api/cli/adapters*` (discovery/validation) + `/api/cli/sessions*` (start/task/stop); `cli.` added to the publish denylist |
| Agent tools | `tools/cli.ts`, `tools/finance-tools.ts` | adapter-agnostic `cli_run` tool alongside untouched `opencode_run` |
| Tests | `__tests__/cli-adapters.test.ts` (28 `it()` blocks) | interface, parsing, argv, registration, validation, lifecycle, streaming, cancellation, timeout, failures, multi-adapter, real-process smoke via `node` |
| Desktop | `lib/cli-api.ts`, `components/chat/CliAdaptersPanel.tsx`, `app/engines/page.tsx` | "Agent CLIs" renders backend metadata only |

---

## 4. Backward compatibility (preserved contract)

- `GET /api/opencode/*`, `POST /api/opencode/run`, `opencode.*` bus events,
  `OpencodeCliInfo` shape, `resolveOpencodeCliPath()` export, `CliProvider`
  defaults, `ProviderRegistry` id `cli-opencode`, `OpencodeDaemonManager`
  name/singleton, direct (shell-free) spawning, publish denylist — all intact.
- **Pending verification:** the pass/fail totals below were *not* re-measured for this
  refactor (test execution is owned by the static verifier). The `28` new cases is a
  static count of `it()` blocks in `__tests__/cli-adapters.test.ts`; the
  `351`/`379` figures are the pre-existing totals carried over and must be
  re-confirmed by an actual run before anyone quotes them:

  > All 351 pre-existing server tests pass unchanged, plus the 28 new ones
  > (total: 379).

