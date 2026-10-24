# AGENT_PROGRESS.md — autonomous development loop

## Current branch and commit
- Branch: `feat/openbot-finance-workspace` @ `700324b` (PR #53 head, base `main`)
- Local worktree: `C:\Users\Naman\finance-agent-ws` (separate worktree; the `Downloads\finance-agent-os` clone keeps unrelated uncommitted opencode-removal edits — do not touch)
- PR: https://github.com/namana843-bit/finance-agent-os/pull/53 (open, 3 files: `Root.tsx`, `app/team/page.tsx`, `team.css`)

## Overall completion status
- Task 1 (baseline): ✅ done — green baseline verified.
- Task 2 (build/test reliability): ✅ satisfied — no failures to fix; documented workspace-ordering footgun (build `@finance/shared`→`@finance/core` before `pnpm typecheck`).
- Task 3 (team workspace ↔ real agents): ✅ verified — all four workspace cards map to real built-in runtime IDs (`btc-quant-agent`, `risk-guardian-agent`, `market-research-agent`, `cline-cli-agent`) registered in `apps/server/src/llm/agent-runtime.ts` (`BUILT_IN_AGENT_IDS`); existing streaming chat, status, paper indicator in `app/team/page.tsx` confirmed reading real APIs (`/api/health`, `/api/agent-runtime/agents`, `/api/portfolio`, `/api/agent-runtime/chat/stream`).
- Task 4 (orchestration): ✅ implemented — see below.
- Task 5 (risk & approval gates): ✅ implemented (approval echo-match, freshness recheck, audit on reject; deterministic risk re-check delegated to pipeline).
- Tasks 6–10: pending.

## Task 4+5 implementation (this iteration)
- New module `apps/server/src/orchestrator/`:
  - `types.ts` — `WorkflowRun`/stages + `validateProposal()` (strict symbol regex, side, positive quantity/price with sane caps, market|limit, ≥10-char rationale).
  - `store.ts` — per-run JSON + index under `<DATA_DIR>/workflows/`, atomic writes (`writeFileAtomic`, same convention as AGENTS.md).
  - `orchestrator.ts` — `TradeWorkflowOrchestrator` (+ `TradeWorkflowService` ServiceLifecycle):
    - Research (`market-research-agent`) → Proposal (`btc-quant-agent`, JSON-only prompt, re-validated server-side) → Risk review (`risk-guardian-agent`, `block` verdict fails the run before approval) → `awaiting_approval`.
    - `approve()` requires exact echo of symbol+side+quantity of the recorded proposal; then freshness recheck (`market-state` entry age ≤ 5 min; missing data fails); execution handed to the existing 7-stage `ExecutionPipeline` (risk ticket/permission/kill-switch/hard-limits/paper rerun there non-bypassably); portfolio snapshot recorded after; audit ids recorded; events published on the bus.
    - `reject()` requires a user reason; records `audit.recorded` event.
    - Restart recovery via `recoverAfterRestart()`: hydrates from disk; any run left `running` (crashed mid-flow, never approved) is marked `failed` — an order can never silently resume.
  - Degraded-agent tolerance: unparseable/invalid LLM proposals fail the run ("failed", no pipeline call) — never auto-converted into an ad-hoc trade.
- Routes (`apps/server/src/core/server.ts`): `GET /api/workflows`, `GET /api/workflows/:id`, `POST /api/workflows` (202, validated symbol/context), `POST /api/workflows/:id/approve` (400 invalid confirm echo → no execution), `POST /api/workflows/:id/reject` (reason required, 409 when not awaiting).
- Registered in `apps/server/src/core/runtime.ts` as `trade-workflow-orchestrator` with accessors wired to real services (`getAgentRuntime`, `getExecutionPipeline`, `getMarketState`, `getPaperBroker`).
- Test `apps/server/__tests__/workflow-orchestrator.test.ts` (10 deterministic tests, stub agents/pipeline, temp-dir persistence): happy path with exact-param approval → signal asserted byte-for-byte; invalid proposal; param mismatch; stale/missing market data; reject; reject-reason required; risk block; validation table; restart recovery incl. never-resuming unapproved running runs.

## Verification results (this iteration, actual)
- `pnpm --filter @finance/server exec vitest run __tests__/workflow-orchestrator.test.ts` — 10/10 pass.
- `pnpm --filter "@finance/server" test` — 41 files / 535 tests, all pass (was 525 before; +10 new).
- `pnpm typecheck` — exit 0.

## Key facts about existing architecture (inspected, do not duplicate)
- `pnpm install` — OK (Prisma client generated, 42.7s).
- `pnpm typecheck` — exit 0 **after** building `@finance/shared` then `@finance/core` first. Initial run failed with TS2307 `Cannot find module '@finance/shared'` because empty `packages/*/dist` litters weren't fetched/shipped. Fix used: `pnpm --filter @finance/shared build && pnpm --filter @finance/core build` before `pnpm typecheck`. Noted as a workspace-ordering footgun, not a code defect (committing `dist` is wrong; leave fix as documented step).
- `pnpm --filter @finance/server test` — **40 files / 525 tests, all passed** (43s). Notable existing coverage: risk-engine, risk-gate, execution-pipeline (permission/daily-limit stages), order lifecycle integration incl. idempotency, paper-broker incl. partial fills, approvals, supervisor (26 tests), CLI API, cowworkers/bots, live-safety (kill switch, reconciliation).
- `AGENT_PROGRESS.md` — created (this file).

## Key facts about existing architecture (inspected, do not duplicate)
- Agents registered on runtime: `market`, `quant`, `risk`, `portfolio`, `execution`, `demo-agent`, `supervisor`, plus coworker bots. NOT yet verified: the workspace-facing IDs `btc-quant-agent`, `risk-guardian-agent`, `market-research-agent`, `cline-cli-agent` (Task 4 must map them in source).
- 7-stage execution pipeline with risk + permission + paper stages; `RiskApprovalTicket` HMAC; KillSwitch; gateway daily limits. Reuse, never bypass.
- `PaperBroker`, `OrderManager`, `TradeEngine`, `AuditLogger`, `ApprovalService`, chat service all already exist as services on the runtime.

## Important architectural decisions
- Work in a dedicated worktree (`C:\Users\Naman\finance-agent-ws`) so the pre-existing uncommitted opencode-removal edits in `Downloads\finance-agent-os` are not destroyed or accidentally committed to this branch.
- Build `shared`→`core` before workspace-wide typecheck.

## Safety checks completed
- Tests confirm paper-only default; `binance-market.test.ts` asserts order creation/cancel methods are prohibited; live-safety suite passes.

## Exact next task
- Task 6 review then Task 7: orchestrator already records PaperBroker-produced fills via the pipeline result; extend persistence checks (workflow + audit history recovery across restart — largely done in tests, verify against real DATA_DIR conventions) and add UI wiring (Task 8): workspace "Run workflow" actions hitting `/api/workflows*`, showing proposal/risk/decision/fill/portfolio states.

## Known failures / blockers
- None. GitHub MCP token cannot update PR bodies on public repos (403) — PR text changes must be done by the user or via `gh auth login` (token currently invalid).
