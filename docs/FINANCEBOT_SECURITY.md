# FinanceBot Security Model

Status: Phase 1 architecture deliverable. Consolidates what is **enforced today** (with the code/tests that prove it) and what must ship before the desktop build leaves the loopback dev posture. Complements `docs/SECURITY.md` (trading-engine security) and `FINANCEBOT_ARCHITECTURE.md` §Desktop security.

## Trust boundaries

```
┌──────────────────────────────────────────────────────────────┐
│ Renderer (React) — UNTRUSTED                                  │
│  • contextIsolation: true, nodeIntegration: false             │
│  • sees keyPresent booleans, never credential values          │
├──────────────── preload: narrow validated IPC only ───────────┤
│ Main process / Fastify server — TRUSTED COMPUTE BASE          │
│  • credentials, provider routing, risk gates, persistence     │
├──────────────── deterministic risk pipeline ───────────────────┤
│ Order execution — ONLY PATH TO MONEY                          │
│  • 7-stage pipeline, HMAC tickets, kill switch                │
└──────────────────────────────────────────────────────────────┘
  External: providers (HTTPS), market data APIs, brokers
```

## 1. Credential handling — enforced today

- API keys are referenced by **env-var name** in `apps/server/src/llm/connections.ts`; the renderer-visible view is `keyPresent: boolean` only.
- `apps/server/src/llm/redact.ts` redacts provider errors, health payloads and model metadata; keys never reach responses, logs, or agent prompts.
- Memory writes pass `sanitizeSecrets()` (`memory/agent-memory.ts`): `/^(api[_-]?key|secret|token|password|credential)/i` → `[REDACTED]`.
- Health gating: a provider only reports "connected" after a real round trip — status is never faked.
- Tests: the provider/secret-redaction contract tests added in Phase 4 (`apps/server` suite, 45 files green).

Planned (Stage 6): OS credential storage (Windows Credential Manager / Keychain) for desktop builds, replacing env vars as the primary source; the `credential_ref` indirection added in the database design makes this a storage swap, not a schema change.

## 2. The money path — non-bypassable (unchanged by FinanceBot)

- Every order traverses the 7-stage pipeline (`execution-pipeline/pipeline.ts`): schema validation → LoopGuard (max depth 5, 15 s per-symbol cooldown) → kill switch → hard limits → HMAC-SHA256 `RiskApprovalTicket` → gateway → OrderManager.
- Enforcement is deterministic code; no LLM output ever reaches a broker directly. FinanceBot chat can *prepare* paper-trade proposals only; advisor agents (e.g. `finance-lead-agent`) hold `permissions.execution=false` and `riskPermissions.allowTradeProposals=false` and cannot be granted them through the UI (archive-guarded built-ins).
- Paper-first default; live requires `EXECUTION_MODE=live` **and** `LIVE_TRADING_ENABLED=true`.
- Financial accuracy rules (`FINANCE_RULES.md`): no NaN/Infinity, symbol normalisation, 30 s quote staleness, zero look-ahead in backtests — all enforced by code, not prompts.

## 3. Desktop hardening — enforced today

- Electron `contextIsolation: true`, `nodeIntegration: false` (`apps/dashboard/electron/main.cjs`).
- Server binds loopback `:4132` in dev; no remote API surface.

Planned (Stage 6, gated on each other):

1. **Per-installation session token** — Fastify issues a token at first launch; the Electron main process holds it and attaches it to requests; loopback stays open for dev only.
2. **CSP** for the renderer, no remote content loading.
3. **IPC allowlist** — explicit validated channels; no generic fs/shell bridge.
4. **Signed updates** for distribution.

## 4. Secrets in transit & untrusted content

- Provider traffic HTTPS with per-connection timeouts (`connections.ts`); fallback models may not spill secrets across providers.
- Chat content, memories, memories Search and tool results are untrusted data: the server never executes instructions found inside them, and the redaction pass runs *before* anything is stored or echoed.
- Prompt-injection containment: agent prompts carry tool allowlists; a tool call not on the coworker's allowlist is refused server-side (tested in `coworker-phase3.test.ts`) regardless of what the model requested.

## 5. Observability & incident surface

- `audit` module (`audit/audit-logger.ts`) records approvals/refusals; the DB design adds `tool_calls.allowed_by` so every admitted or refused tool call is attributable to a rule.
- Provider errors surface as typed events on the SSE bus; CI failure (run #41238863390) showed the pipeline discipline: breaks are fixed at the source, never bypassed.

## Honest limits in the current build

- The API is loopback-unauthenticated; do not expose or port-forward it.
- Credential storage is env-based, not OS-keystore-based.
- No CSP / signing yet — distribution of built binaries must wait for Stage 6 items 1–4.
- No bug bounty / external audit; the security claims here are code-verified only to the extent of the shipped test suite (45 files, 594+ tests after the Phase-4/CI-fix work).
