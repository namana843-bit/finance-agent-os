# AGENT_PROGRESS.md — autonomous development loop

## Current branch and commit
- Branch: `feat/openbot-finance-workspace`
- Worktree: `C:\Users\Naman\finance-agent-ws` (separate worktree; the
  `Downloads\finance-agent-os` clone keeps unrelated uncommitted edits — do not touch)
- At the start of this loop the tree had uncommitted trade-workflow work
  (`runtime.ts`, `server.ts`, `src/orchestrator/`). It was preserved, and the missing
  `PipelineRunner` type import was restored so the tree typechecks. During the loop
  that work was committed by something outside this session as `0b7e381`
  (orchestrator) and `dd20ae8` (paper-trade UI); this session made no commits.
- All coding-workspace work below is **uncommitted** on this branch.

## Task lineage
Earlier loop: finance dashboard / team workspace (PR #53). **Current task:** build a
multi-coding-agent desktop workspace inside this app (OpenBot-style), reusing the
existing CLI adapter layer.

## Overall completion status
| Phase | Scope | Status |
|---|---|---|
| 1 | Typed agent-provider contract | ✅ done (extended `src/coding`) |
| 2 | Agent registry with real status | ✅ done |
| 3 | Adapters (OpenCode, Claude, Gemini, Codex) | ✅ discovery live; OpenCode turns verified live (see Increment 5); Claude blocked by an invalid model config |
| 4 | Unified desktop UI | ✅ built (`#/coding`), typecheck + prod build pass |
| 5 | Safe project execution | ✅ path validation, per-session isolation, cancellation; ⚠️ no interactive permission channel exists in any adapter |
| 6 | Deterministic tests | ✅ 47 new tests (29 unit + 18 route); full suite 582 pass |
| 7 | Completion | ⏳ pending: per-provider model enumeration, Claude model config |

## What was already there (inspected, not duplicated)
`apps/server/src/cli/` is a mature adapter layer: `CliAdapter` contract, `CliManager`
(register/validate/start/sendTask/streamEvents/stop), `process-runner` (argv arrays,
denied env keys, tree kill), adapters for `cline`, `opencode`, `claude`, `codex`,
`gemini`, `cursor-cli`, `cline-cli`, plus ACP/JSON-line transports. `/api/cli/*` routes
already existed. The coding workspace is a **view** over that layer, not a second
adapter system.

## Increment 1 — coding agent domain (done, verified)
New files:
- `apps/server/src/coding/types.ts` — `CodingCapabilityId`, `Capability`
  (`{supported:true}` | `{supported:false, reason}`), provider descriptor/status,
  projects, sessions, turns, `CodingTurnEvent`, permission requests.
- `apps/server/src/coding/providers.ts` — `CodingProviderRegistry` over `CliManager`.
  Capabilities derived from adapter metadata only; unknown → explicit unsupported.
  Auth verdict derived from probe error text (regex), never a credential value.
- `apps/server/src/coding/projects.ts` — `validateProjectPath` (absolute only,
  `..` rejected, filesystem roots / home dir / credential dirs / OS prefixes /
  `node_modules` blocked, optional `allowedRoots`, realpath + stat) and
  `CodingProjectStore` (atomic 0600 JSON, git branch/dirty detection).
- `apps/server/src/coding/sessions.ts` — `CodingSessionManager`: one provider +
  one project + one CLI session per record; streams `CliEvent`s into
  `CodingTurnEvent`s; cancellation; persistence that never restores `running`.
- `apps/server/src/coding/routes.ts`, `apps/server/src/coding/index.ts`
  (`getCodingWorkspace`, test hooks) and wiring in `core/server.ts`.

Routes: `GET /api/coding/providers[?refresh=1]`, `GET/POST /api/coding/providers/:id`,
`POST /api/coding/providers/:id/refresh`, `GET /api/coding/providers/:id/models`
(501 + reason), `GET/POST /api/coding/projects`, `DELETE /api/coding/projects/:id`,
`GET /api/coding/projects/:id/status`, `GET/POST /api/coding/sessions`,
`GET/DELETE /api/coding/sessions/:id`, `POST .../turns`, `POST .../turns/stream` (SSE),
`POST .../cancel`, `GET .../permissions` (501 + reason).

## Increment 2 — desktop UI (done, builds)
- `apps/dashboard/src/lib/coding-api.ts` — typed client + SSE reader.
- `apps/dashboard/src/app/coding/page.tsx` + `coding.css` — provider cards with real
  install/version/auth, project add/remove (server-validated paths), per-provider
  session history, streaming chat, cancel, capability matrix with reasons, terminal
  output (stdout/stderr + tool calls), git branch/dirty, auth guidance.
- `Root.tsx` route `#/coding`; nav links added on both the team and coding pages.

## Increment 3 — working-tree review (done, verified)
- `readProjectDiff` in `coding/projects.ts`: `git status --porcelain`, `git diff --stat`,
  and a 60k-capped unified `git diff`; read-only, bounded, never throws. Non-repo →
  `isRepo: false`.
- `GET /api/coding/projects/:id/diff`; 404 for unknown projects.
- UI: CHANGES block in the session context panel — changed-file list with status
  badges, file count, "Review patch" toggle rendering the unified diff. Refresh
  happens on project switch and after every completed turn.
- Live check: `prj-4cf10ad0` reported 9 changed files and a 18,587-char patch; the
  panel and patch rendered in the browser.

## Increment 4 — isolated git worktrees (done, verified)
- `coding/worktrees.ts`: `createSessionWorktree` (`git worktree add -b coding/<session>`
  under `<dataDir>/coding/worktrees`), `removeSessionWorktree`, `listProjectWorktrees`,
  `isGitRepository`. Argv arrays only; fails instead of falling back to the shared tree.
- Session policy (`sessions.ts`):
  - `isolate: true` runs the provider with `cwd` = the session worktree and records
    `isolated`, `worktreePath`, `worktreeBranch`.
  - A non-isolated session is refused with `project_busy` while another session on the
    same project is running — parallel agents cannot race one working tree.
  - Isolation on a non-repo / commit-less repo returns `isolation_unavailable`
    (501), not a silent fallback.
  - Failed provider start removes the freshly created worktree.
- `DELETE /api/coding/sessions/:id/worktree` requires `?force=1` to discard
  uncommitted agent work; the UI asks for confirmation first.
- UI: "isolated worktree" checkbox in the composer, worktree path + branch rows and a
  "Remove worktree" button in the session context panel.
- Live check: created `cs-957a1e37` isolated on the real repo →
  `~/.finance-agent/coding/worktrees/cs-957a1e37` existed on branch
  `coding/cs-957a1e37`; removal deleted both.

## Verification (actual results)
- `pnpm --filter @finance/shared build && pnpm --filter @finance/core build` — OK.
- `pnpm --filter @finance/server exec tsc --noEmit` — exit 0.
- `pnpm --filter @finance/dashboard exec tsc --noEmit` — exit 0.
- `pnpm --filter @finance/dashboard build` — OK (1599 modules, 5.16s).
- `pnpm --filter @finance/server test` — **43 files / 574 tests passed**.
  New: `__tests__/coding-workspace.test.ts` (25), `__tests__/coding-api.test.ts` (14).
- Live discovery on this machine (`GET /api/coding/providers`):
  opencode `1.19.4` installed, claude `2.1.288` installed, gemini installed,
  cline + cline-cli installed, codex **not installed**, cursor-cli **not installed**.
  Reported honestly in the UI (installed flag comes from a real probe).

## Live turn — now verified (Increment 5)
OpenCode previously failed with `[invalid_value] ... 'tools': maximum number of items
is 128` because the user-level OpenCode config enables two MCP servers (`cua` 138
tools, `cua-driver` 57 tools) and the selected model rejects >128 tools. The adapter
was never at fault; the model/tool budget was.

Fix used (no code change, no edit to the user's global config): launch the **server**
with `OPENCODE_CONFIG` pointing at a session config that disables those MCP servers.
```json
{ "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "cua": { "type": "local", "command": ["x"], "enabled": false },
    "cua-driver": { "type": "local", "command": ["x"], "enabled": false }
  } }
```
Verified end-to-end on 2026-10-24:
- Non-streaming turn: `POST /api/coding/sessions/cs-ad86e853/turns` returned
  `content = "PONG"`, `status = idle`, events `status,terminal,terminal,terminal,exit,text`.
- SSE turn: `POST .../turns/stream` emitted `status` → three `terminal` chunks
  (stderr banner + `PONG`) → `exit` → `text` → `turn_complete` for model `beam-free`.
- A real provider turn now runs through the workspace with a real install probe.

Remaining provider blocker (environment, not adapter): **Claude Code** still hangs —
the configured model `minimax-m2.5-free` is rejected (`unrecognized_model`) and Claude
retries 10×; the turn times out correctly at 180 s and answers
`502 {code:"turn_failed"}`. Pick a valid Claude model to exercise that provider.

## Safety checks completed
- Project paths validated before any session start; the CLI process cwd is that path.
- No shell-string command construction: adapter argv arrays only, prompt passed as an
  argument (existing `process-runner` policy, reused).
- Session records carry providerId + projectId + projectPath; events from another
  `cliSessionId` are dropped in `mapEvent` (tested).
- Provider payloads contain no env values or credentials (route test asserts this).

## Exact next task
1. Add per-provider model selection: adapters expose no model list, so either add a
   declared list to adapter metadata or a provider-specific `models` probe; until then
   the API keeps answering 501 with a reason.
2. Give Claude Code a valid configured model and verify one live turn (the adapter,
   timeout and error path already work).
3. Optional: session-worktree diff review (show `git status` inside a session worktree
   instead of the project tree).
4. Not done, and not doable through current adapters: interactive permission prompts.
   `/api/coding/sessions/:id/permissions` answers 501 with a reason. Safety caveat:
   the OpenCode adapter launches `opencode run --auto`, i.e. it auto-approves its own
   tool calls. Combined with per-session worktrees this keeps damage reviewable, but
   the workspace cannot ask the user before a destructive write. Removing `--auto`
   requires an adapter-level permission channel that no provider currently exposes.
