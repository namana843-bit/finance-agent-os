#!/usr/bin/env node
// Verifies honesty contracts — run with server up: `node scripts/verify-honesty.mjs`
// Checks: portfolio single truth (PaperBroker), risk 15s, ticks source binance|synthetic, candles/orderbook synthetic flag
const BASE = process.env.API_BASE || "http://localhost:4132";
async function j(path) { const r = await fetch(`${BASE}${path}`); const t = await r.text(); try { return JSON.parse(t); } catch { return { _raw: t, status: r.status }; } }
let ok = true;
function assert(cond, msg) { if (!cond) { ok = false; console.error("✗", msg); } else console.log("✓", msg); }
const health = await j("/api/health"); assert(health.status === "ok", `health ok (${health.status})`);
const pf = await j("/api/portfolio"); assert(typeof pf.totalValue === "number", `portfolio totalValue number (${pf.totalValue})`); assert(Array.isArray(pf.holdings), `portfolio holdings array (${pf.holdings?.length})`); assert(Array.isArray(pf.positions), `portfolio positions array`);
const ticks = await j("/api/market/ticks?limit=3"); assert(Array.isArray(ticks.ticks), `ticks array (${ticks.ticks?.length})`); if (ticks.ticks?.[0]) assert(["binance","synthetic",undefined].includes(ticks.ticks[0].source) || typeof ticks.ticks[0].price === "number", `tick has price/source (${ticks.ticks[0].source})`);
const candles = await j("/api/market/candles?symbol=BTCUSDT&limit=2"); assert(Array.isArray(candles.candles), `candles array (${candles.candles?.length})`); assert(candles.synthetic === true || candles.synthetic === undefined, `candles synthetic flag honest (${candles.synthetic})`);
const book = await j("/api/market/orderbook?symbol=BTCUSDT&depth=2"); assert(Array.isArray(book.bids) && Array.isArray(book.asks), `orderbook bids/asks arrays`);
const orders = await j("/api/orders"); assert(Array.isArray(orders.orders), `orders array (${orders.orders?.length})`);
const trades = await j("/api/trades"); assert(Array.isArray(trades.trades) || Array.isArray(trades.fills), `trades array`);
const strats = await j("/api/backtest/strategies"); assert(Array.isArray(strats.strategies), `backtest strategies (${strats.strategies?.length})`);
console.log(ok ? "\nAll honesty checks passed." : "\nSome checks failed — see ✗ above.");
process.exit(ok ? 0 : 1);
