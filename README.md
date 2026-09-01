# Finance Agent OS - OpenBot-style

Event API / SSE core with 5 finance agents:
Market -> Quant -> Risk -> Portfolio -> Execution -> Binance/Broker

```
Dashboard (Web/Terminal/API) -> Event API/SSE -> Finance Agent OS -> Agents
```

## Quick start
```bash
pnpm install
pnpm dev:server   # port 4132
pnpm dev:dashboard # port 3000
```

## API
- GET /api/events  SSE
- POST /api/publish {type, data, channelId, threadId, agentId}
- GET /api/state
- GET /api/health
- GET /api/portfolio
- GET /api/market/ticks
```
