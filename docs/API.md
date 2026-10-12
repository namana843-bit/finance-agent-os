# REST API

Base URL: `http://localhost:4132`

## Health

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/health` | System health check |

## Agents

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agents` | List all agents with status |
| POST | `/api/agents/:id/start` | Start an agent |
| POST | `/api/agents/:id/stop` | Stop an agent |

## Market

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/market/ticks?limit=20&symbol=BTCUSDT` | Recent market ticks |
| GET | `/api/market/candles?symbol=BTCUSDT&limit=100` | OHLCV candles |
| GET | `/api/market/orderbook?symbol=BTCUSDT&depth=10` | Order book |
| GET | `/api/market/state` | Current market state |

## Quantitative

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/signals?limit=20` | Recent trading signals |
| POST | `/api/trading/signal` | Manually trigger a signal |

## Strategies

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/strategies` | List strategies |
| POST | `/api/strategies` | Register a strategy |
| POST | `/api/strategies/:id/toggle` | Enable/disable strategy |

## Risk

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/risk/status` | Current risk status |
| GET | `/api/risk/metrics` | Detailed risk metrics |

## Portfolio

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/portfolio` | Portfolio overview |
| GET | `/api/portfolio/positions` | All positions |
| GET | `/api/portfolio/allocation` | Allocation breakdown |
| GET | `/api/portfolio/history` | Portfolio snapshots |

## Orders

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/orders` | List all orders |
| GET | `/api/orders/:id` | Get specific order |
| POST | `/api/orders/:id/cancel` | Cancel order |

## Trades

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/trades` | List all trades |

## Gateway

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/gateway/trade` | Submit trade through gateway |
| GET | `/api/gateway/stats` | Gateway statistics |

## Execution

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/execution/status` | Execution stats & mode |

## Audit

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/audit?eventType=risk.approved&limit=50` | Audit log |

## CLI Adapters

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/cli/adapters` | List registered CLI adapters with installation info |
| GET | `/api/cli/adapters/:id` | Adapter metadata + installation status |
| POST | `/api/cli/adapters/:id/validate` | Re-validate adapter installation |
| GET | `/api/cli/sessions` | List managed CLI sessions |
| POST | `/api/cli/sessions` | Start a session (`{adapterId, cwd?, env?, args?, timeoutMs?}`) |
| GET | `/api/cli/sessions/:id` | Session summary |
| POST | `/api/cli/sessions/:id/tasks` | Send a task (`{task, model?, agentId?, timeoutMs?}`) |
| DELETE | `/api/cli/sessions/:id` | Stop a session |

## Agent CLI Gateway (Cline — primary)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/cline/cli-path` | Resolved `cline` binary info (`CLINE_CLI_PATH` override + candidates) |
| GET | `/api/cline/paths` | Path gateways (candidates + existence + allowlist) |
| GET | `/api/cline/gateway/stats` | Gateway run/reject stats |
| POST | `/api/cline/run` | Permissioned run (`{command?, args?, agentId?}` — bare prompt stays one arg) |

Example — one-shot prompt (no shell, prompt is a single argv element):

```bash
curl -X POST http://localhost:4132/api/cline/run \
  -H 'Content-Type: application/json' \
  -d '{"command":"summarize the portfolio risk","agentId":"api"}'
# → {"result":{"ok":true,"exitCode":0,"stdout":"…","cliPath":"…","command":"…","gated":{"allowed":true}}}
```

Example — allowlisted subcommand:

```bash
curl -X POST http://localhost:4132/api/cline/run \
  -H 'Content-Type: application/json' \
  -d '{"args":["--version"],"agentId":"api"}'
```

Status codes: `200` ok · `400` missing command/args · `403` rejected by the
allowlist/metachar policy · `500` ran but the process failed · `503` gateway
not registered. Auth is the local CLI's own (`cline auth`); no credentials
are accepted or logged by these endpoints.

Legacy OpenCode endpoints (`/api/opencode/*`) remain for backward compatibility — they are
now backed by the deprecated OpenCode adapter/gateway subclass. Normalized CLI events stream as `cli.*` over SSE.
These events are server-owned: `POST /api/publish` rejects the `cli.` prefix (along with
`supervisor.`, `risk.`, `gateway.`, `order.`, `trade.proposal_`, `audit.kill_switch`,
`opencode.`, `cline.`) with `403` — see `core/server.ts` `deniedPrefixes`.

### CLI conventions

- **Trust model:** same as every other route (single-user localhost app, no
  per-route auth). Safety comes from argv-only spawning (never shell strings),
  adapter-declared shell policy, env-override denylist, and input validation —
  not from credentials on these endpoints.
- **No secrets in responses:** metadata, validation (`resolvedPath`, `version`,
  `error`), summaries and task results never include environment values.
- **Status codes:** `200` ok · `400` invalid input (bad `mode`/`timeoutMs`/
  `cwd`/`env`/`args`/`task`) · `404` unknown adapter or session ·
  `409` task against a stopped/failed session · `500` task executed but the
  process failed (see `result`: `ok`, `exitCode`, `timedOut`, `cancelled`,
  `error`, `outputTruncated`).
- **Input limits:** `task` ≤ 200k chars; `model`/`agentId` ≤ 256 chars;
  `timeoutMs` clamped to 30 min; `args` ≤ 50 items × 4k chars; `env` ≤ 50 keys
  (`^[A-Za-z_][A-Za-z0-9_]*$`, values ≤ 8k); `cwd` must be an existing directory.
- **Streaming:** subscribe to `GET /api/events?type=cli.output` (or
  `cli.tool_activity`, `cli.session_failed`, …) for normalized live output and
  lifecycle events; `task_started`/`text_delta` identify per-task deltas.

```bash
# List providers with capabilities + installation status
curl http://localhost:4132/api/cli/adapters

# Start a session (mode is negotiated; unsupported modes return 400)
curl -X POST http://localhost:4132/api/cli/sessions \
  -H "Content-Type: application/json" \
  -d '{"adapterId":"claude","timeoutMs":120000}'

# Run a task — 200 carries { result: { ok, output, toolActivities,
# exitCode, timedOut, cancelled, durationMs } }
curl -X POST http://localhost:4132/api/cli/sessions/<id>/tasks \
  -H "Content-Type: application/json" \
  -d '{"task":"explain this repo","model":"sonnet"}'

# Stream live output for the session
curl "http://localhost:4132/api/events?type=cli.output&replay=false"

# Stop the session (cancels the in-flight task, terminates the process)
curl -X DELETE http://localhost:4132/api/cli/sessions/<id>
```

## Custom Bots (agent-runtime)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/agent-runtime/agents?includeArchived=1` | List bots (archived hidden by default) |
| POST | `/api/agent-runtime/agents` | Create a bot (`{name, engine, systemPrompt\|responsibilities, …}`) |
| GET | `/api/agent-runtime/agents/:id` | Fetch one bot |
| PUT | `/api/agent-runtime/agents/:id` | Full update (path id wins; archived flag preserved) |
| POST | `/api/agent-runtime/agents/:id/archive` | Soft-delete (cancels in-flight run) |
| POST | `/api/agent-runtime/agents/:id/unarchive` | Restore an archived bot |
| DELETE | `/api/agent-runtime/agents/:id` | Hard delete |
| GET | `/api/agent-runtime/templates` | Curated starter templates (safety rails included) |
| GET | `/api/agent-runtime/providers` | Providers with capabilities + backing-adapter status |

Conventions:

- **Validation:** create/update/import run Step-1 `validateCoworkerInput`
  (name, engine, tools, prompt length, permission coherence). Engine ids must
  resolve through the real `EngineManager` (backed by registered CLI
  adapters); tools must exist in the tool registry. Failures return `400`
  with `{ error, details: string[] }`; duplicate ids return `409`.
- **No executable config:** `command`, `args`, `cwd`, `executablePath`,
  `env`, `shell`, etc. are rejected with `400` — bots carry only
  `{engine, model, systemPrompt, tools, permissions, riskPermissions}`.
  Ids are slug-shaped (`[a-z0-9-]`), so path traversal via ids is impossible.
- **Authorization:** single-user localhost app, no per-route auth (same trust
  model as every other route). Built-in system agents
  (`btc-quant-agent`, `risk-guardian-agent`, `cline-cli-agent`,
  `market-research-agent`) return `403` on archive/delete; they can still be
  updated.
- **Status codes:** `200` ok · `400` invalid input or id mismatch ·
  `403` built-in protected · `404` unknown bot · `409` duplicate id,
  already-archived, or not-archived.
- **Persistence:** bots live in `agents.json` under `FINANCE_DATA_DIR`
  with `createdAt`/`updatedAt`; archiving only flips a flag.

```bash
# Create a bot
curl -X POST http://localhost:4132/api/agent-runtime/agents \
  -H 'Content-Type: application/json' \
  -d '{"name":"ETH Scout","engine":"cline-cli","responsibilities":["Watch ETH funding rates"],"tools":["get_market_price"]}'

# Update it (full replacement; archived/createdAt preserved)
curl -X PUT http://localhost:4132/api/agent-runtime/agents/coworker-eth-scout \
  -H 'Content-Type: application/json' \
  -d '{"name":"ETH Scout v2","engine":"cline-cli","systemPrompt":"You analyze ETH funding ... (40+ chars)"}'

# Archive / restore / delete
curl -X POST http://localhost:4132/api/agent-runtime/agents/coworker-eth-scout/archive
curl -X POST http://localhost:4132/api/agent-runtime/agents/coworker-eth-scout/unarchive
curl -X DELETE http://localhost:4132/api/agent-runtime/agents/coworker-eth-scout

# Providers with capabilities (adapter executable, install status, engines, health)
curl http://localhost:4132/api/agent-runtime/providers
```

## Events (SSE)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/events?type=market.tick&replay=true` | Real-time event stream |
| POST | `/api/publish` | Publish event |

## State

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/state` | Full runtime state |
