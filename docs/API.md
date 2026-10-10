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

Legacy OpenCode endpoints (`/api/opencode/*`) remain for backward compatibility — they are
now backed by the OpenCode adapter. Normalized CLI events stream as `cli.*` over SSE.
These events are server-owned: `POST /api/publish` rejects the `cli.` prefix (along with
`supervisor.`, `risk.`, `gateway.`, `order.`, `trade.proposal_`, `audit.kill_switch`,
`opencode.`) with `403` — see `core/server.ts` `deniedPrefixes`.

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

## Events (SSE)

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/events?type=market.tick&replay=true` | Real-time event stream |
| POST | `/api/publish` | Publish event |

## State

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/state` | Full runtime state |
