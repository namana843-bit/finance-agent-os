# Security

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `PORT` | No | 4132 | Server port |
| `HOST` | No | 0.0.0.0 | Server host |
| `EXECUTION_MODE` | No | paper | `paper` or `live` |
| `LIVE_TRADING_ENABLED` | No | false | Must be `true` for live trading |
| `BINANCE_API_KEY` | No | — | Binance API key |
| `BINANCE_SECRET` | No | — | Binance API secret |

## Safety Rules

1. **Paper mode is always default.** Live trading requires explicit opt-in.
2. **Live trading requires BOTH flags:** `EXECUTION_MODE=live` AND `LIVE_TRADING_ENABLED=true`
3. **Secrets are never exposed** to the frontend, SSE, or logs.
4. **Rate limiting** is available via `checkRateLimit()`.
5. **All financial actions** go through the Finance Gateway for audit.

## Never

- Never commit `.env` files
- Never log API keys or secrets
- Never send secrets through SSE
- Never expose secrets in API responses
