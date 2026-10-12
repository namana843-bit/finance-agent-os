# Building Your Own Coworker AI Bots

Finance Agent OS ships with 6 built-in trading agents, but you can build your
own **coworker bots** for your workflow: a scalping watcher, an ETH-only
analyst, a conservative risk second-opinion, etc.

## Quick start

1. **Pick a template** — `GET /api/agent-runtime/templates` returns 5
   production-ready starting points (`quant-analyst`, `risk-guardian`,
   `market-researcher`, `execution-assistant`, `strategy-scout`), each with a
   full system prompt, tool allowlist, and safe permission defaults.
2. **Create the bot** — `POST /api/agent-runtime/agents`:
   ```json
   {
     "name": "ETH Scout",
     "engine": "opencode-cli",
     "role": "Strategy Researcher",
     "responsibilities": ["Explore RSI divergences on ETH 1h data"],
     "tools": ["get_ohlcv", "calculate_rsi"]
   }
   ```
   Pass `systemPrompt` directly instead of `responsibilities` for full control.
3. **Chat with it** — `POST /api/agent-runtime/chat/stream` with
   `{ "agentId": "<id>", "prompt": "..." }`.
4. **Export / import** — `GET .../agents/:id/export`,
   `POST .../agents/import` (import always mints a collision-free id).

## What prompt does a bot need?

You provide **either** `systemPrompt` **or** `responsibilities` (+ optional
`constraints`). A production-level prompt is built as:

```
role → responsibilities → available tools → constraints → safety rails
```

Every stored prompt is automatically appended with non-negotiable safety
rails (paper-only, never bypass risk/approvals, no invented data, no
look-ahead, fees/slippage accounted, no secrets) unless already present —
see `COWORKER_SAFETY_SUFFIX` in `apps/server/src/coworkers/`.

## Creation rules (validated, 400/409 on violation)

- `name` 2–80 chars; `id` auto-derived as a slug, or provide your own
  (`[a-z0-9-]{3,64}`); duplicate ids → `409`.
- `engine` must resolve to a registered provider (unknown → `400`).
- `tools` must be a subset of the registry (`400` lists the valid ones).
- `riskPermissions.allowTradeProposals: true` requires
  `permissions.execution: true` **and** the `create_trade_proposal` tool.
- `riskPermissions.maxOrderSize` is capped at `10` at creation time.
- Imported bots keep their `id` only when valid and free.

Nothing here bypasses the 7-stage execution pipeline: proposals from your
bots still need HMAC risk tickets, gateway permission, and order-manager
acceptance (`RISK_RULES.md`).
