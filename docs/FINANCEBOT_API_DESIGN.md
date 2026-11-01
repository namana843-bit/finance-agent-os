# FinanceBot API Design

Status: Phase 1 architecture deliverable. This documents (a) the endpoints that already exist and are reused, and (b) the `/api/financebot/*` namespaces that FinanceBot adds incrementally, per `FINANCEBOT_ARCHITECTURE.md` §API and event contracts. Route tags: **[existing]** ships today; **[planned]** contract only — no placeholder endpoints are registered until implemented.

Bootstraps all requests. Existing server: `apps/server/src/core/server.ts`, bound to loopback `:4132`.

## Conventions

- All bodies JSON, camelCase; errors follow Fastify's `{ statusCode, error, message }` with 403 carrying a machine-readable `reason` (`builtin-agent`, `permission-denied`, `risk-gate`).
- Every mutation returns the resulting resource, not a boolean.
- SSE at `/api/events` [existing] carries typed events; financebot run/channel events reuse the same transport.
- No endpoint ever returns a credential value; provider responses expose `keyPresent: boolean` only.

## Reused existing endpoints [existing]

| Endpoint | Purpose | Owner module |
| :--- | :--- | :--- |
| `GET /api/agent-runtime/agents` | Coworker list incl. built-ins | `llm/agent-runtime.ts` |
| `POST /api/agent-runtime/agents` / `DELETE …/:id` | Custom coworker CRUD (built-ins archive-guarded) | same |
| `PATCH /api/agent-runtime/agents/:id/model` | Per-coworker model (400/404/403 guards) | same |
| `POST /api/agent-runtime/conversations` | Create conversation | same |
| `GET /api/agent-runtime/conversations?agentId=` | List conversations | same |
| `GET /api/agent-runtime/conversations/:agentId/:id/messages` | History (404 unknown) | same |
| `POST …/messages` `{ prompt }` | Stream a reply (SSE stream) | same |
| `POST …/stop` / `POST …/regenerate` | Stop/regenerate run | same |
| `GET /api/agent-runtime/conversations/search?agentId=&q=` | History search | same |
| Provider catalog/connections/health/model discovery routes | Multi-provider layer, secret-redacted | `llm/provider-catalog.ts`, `llm/connections.ts`, `llm/registry.ts` |
| Market/portfolio/ohlcv/risk/orders endpoints (`/api/market/*`, `/api/portfolio/*`, `/api/orders/*`, `/api/risk/*`) | Finance data + paper pipeline | `finance-*`, `risk-engine`, `order-manager` |
| `/api/events` (SSE) | Live event stream | `core/server.ts` |

Coworker management and chat routes were verified by `apps/server/__tests__/coworker-phase3.test.ts` (5 tests) and `coworker-phase5-chat.test.ts` (7 tests).

## Planned: workspaces & channels

```http
POST   /api/financebot/workspaces { name }                     [planned]
GET    /api/financebot/workspaces                              [planned]
POST   /api/financebot/workspaces/:id/channels { slug, purpose }[planned]
GET    /api/financebot/channels?workspaceId=                   [planned]
GET    /api/financebot/channels/:id/events?after=<seq>&limit=  [planned]  # replay cursor
POST   /api/financebot/channels/:id/messages { body }          [planned]  # sanitised, dehydrates to channel_events
POST   /api/financebot/channels/:id/members { coworkerId, role }[planned]
```

- `after` cursor is `channel_events.seq` — clients replay exactly-once across reconnects.
- Handoffs: `POST /api/financebot/channels/:id/handoffs { fromCoworkerId, toCoworkerId, taskId, note }` [planned] — creates a `handoff` channel event; the receiving coworker is queued, not immediately run.

## Planned: tasks & runs

```http
POST   /api/financebot/tasks { title, description?, assignedTo?, priority?, dependsOn? } [planned]
GET    /api/financebot/tasks?status=&assignedTo=               [planned]
GET    /api/financebot/tasks/:id                               [planned]
POST   /api/financebot/tasks/:id/cancel { reason }             [planned]
GET    /api/financebot/tasks/:id/runs                          [planned]
GET    /api/financebot/runs/:runId/events?after=<seq>          [planned]
```

- Transition rules enforced server-side (`waiting_approval → running` requires an `approvals` row in `granted`; `running → done` only with completed run); invalid moves → 409.
- Approval flow: trade or tool approvals **never** mint risk tickets. The existing HMAC `RiskApprovalTicket` path (`risk-engine/ticket.ts`, 7-stage pipeline) is the sole gate; the approval API only records human decisions that release work to run.

## Planned: coworker profile extensions

Built on the existing agents API:

```http
GET    /api/financebot/coworkers/:id/profile                   [planned] # identity, instructions version, memory scope, current task
PUT    /api/financebot/coworkers/:id/instructions { body }     [planned] # bumps coworker_instructions version
GET    /api/financebot/coworkers/:id/memory?q=                 [planned] # visual memory browser (agent-scope)
DELETE /api/financebot/coworkers/:id/memory/:memoryId          [planned]
```

Built-ins remain archive-guarded and model-locked (`403 reason: builtin-agent`) exactly as shipped.

## Planned: scheduler

```http
POST /api/financebot/schedules { name, cron, action: { kind: 'channel_digest'|'task_create', ... } } [planned]
GET  /api/financebot/schedules / DELETE /api/financebot/schedules/:id [planned]
```

Runs inside the long-lived Fastify process; no provider-side scheduling.

## Error & auth posture

- Phase 1 ships unauthenticated on loopback exactly like the current server; per-installation session token arrives with the [Security roadmap](FINANCEBOT_SECURITY.md) before any non-loopback binding.
- Provider failures map to 502 with a redacted message detail; the S_ERROR never contains raw provider output with secret headers.

## Test contract

Every implemented route ships Vitest coverage in the existing suite, mirroring `coworker-phase5-chat.test.ts` guard style (201/200/400/403/404/409 paths), plus secret-redaction assertions for any response that echoes configuration.
