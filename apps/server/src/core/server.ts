import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { TypedEventBus, type EventBusOptions } from "@finance/core";
import type { FinanceEvent, HistoryFilter } from "@finance/shared";
import { getRuntime, getGateway, getAuditLogger, getMarketState, getStrategyRegistry, getPaperBroker } from "./runtime.js";

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ServerOptions {
  port?: number;
  host?: string;
  bus?: TypedEventBus;
  logger?: boolean;
}

export async function buildServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const bus = opts.bus ?? new TypedEventBus();

  const app = Fastify({
    logger: opts.logger ?? true,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  // -------------------------------------------------------------------------
  // GET /api/health
  // -------------------------------------------------------------------------
  app.get("/api/health", async () => {
    const runtime = getRuntime();
    const health = runtime ? await runtime.getHealth() : null;
    return {
      status: "ok",
      uptime: process.uptime(),
      timestamp: Date.now(),
      version: "0.1.0",
      runtime: health ? {
        status: health.status,
        agents: Object.keys(health.agents).length,
        tools: health.components.tools,
        strategies: health.components.strategies,
        events: health.eventBusSize,
      } : null,
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/agents
  // -------------------------------------------------------------------------
  app.get("/api/agents", async () => {
    const runtime = getRuntime();
    if (!runtime) return { agents: [] };
    const agents = runtime.getAgentRegistry().list();
    return {
      agents: agents.map((a) => ({
        id: a.id,
        name: a.name,
        version: a.version,
        description: a.description,
        capabilities: a.capabilities,
        status: a.getStatus(),
        health: a.getHealth(),
      })),
    };
  });

  // -------------------------------------------------------------------------
  // POST /api/agents/:id/start
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/agents/:id/start", async (request, reply) => {
    const runtime = getRuntime();
    if (!runtime) return reply.status(503).send({ error: "runtime not available" });
    const agent = runtime.getAgentRegistry().get(request.params.id);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    try {
      await agent.start();
      return { ok: true, agent: { id: agent.id, status: agent.getStatus() } };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/agents/:id/stop
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/agents/:id/stop", async (request, reply) => {
    const runtime = getRuntime();
    if (!runtime) return reply.status(503).send({ error: "runtime not available" });
    const agent = runtime.getAgentRegistry().get(request.params.id);
    if (!agent) return reply.status(404).send({ error: "agent not found" });
    try {
      await agent.stop();
      return { ok: true, agent: { id: agent.id, status: agent.getStatus() } };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/strategies
  // -------------------------------------------------------------------------
  app.get("/api/strategies", async () => {
    const runtime = getRuntime();
    if (!runtime) return { strategies: [] };
    return { strategies: runtime.getStrategyRegistry().list() };
  });

  // -------------------------------------------------------------------------
  // GET /api/risk/status
  // -------------------------------------------------------------------------
  app.get("/api/risk/status", async () => {
    const runtime = getRuntime();
    if (!runtime) return { risk: null };
    const riskAgent = runtime.getAgentRegistry().get("risk");
    if (!riskAgent || typeof (riskAgent as any).getRiskMetrics !== "function") {
      return { risk: null };
    }
    return { risk: (riskAgent as any).getRiskMetrics() };
  });

  // -------------------------------------------------------------------------
  // GET /api/portfolio — single truth: PaperBroker (cash/positions), fallback PortfolioAgent
  // -------------------------------------------------------------------------
  app.get("/api/portfolio", async (_request, reply) => {
    const runtime = getRuntime();
    if (!runtime) {
      return reply.status(503).send({ error: "runtime not available", code: "RUNTIME_NOT_READY" });
    }

    // Single source of truth: PaperBroker owns cash + positions (real fills).
    // PortfolioAgent tracks derived PnL/allocation but duplicates cash — prefer broker.
    const broker = getPaperBroker();
    const portfolioAgent = runtime.getAgentRegistry().get("portfolio");
    const riskAgent = runtime.getAgentRegistry().get("risk");
    const riskMetrics = riskAgent && typeof (riskAgent as any).getRiskMetrics === "function"
      ? (riskAgent as any).getRiskMetrics()
      : null;

    let totalValue: number; let availableCash: number; let realizedPnL = 0; let unrealizedPnL = 0;
    let holdings: Array<{ symbol: string; qty: number; avgPrice: number; price: number; value: number; pnl: number }>;
    let positions: Array<{ symbol: string; side: "long" | "short"; qty: number; entry: number; mark: number; unrealizedPnl: number; leverage: number }>;

    if (broker) {
      const pf = broker.getPortfolio();
      totalValue = pf.equity;
      availableCash = pf.cash;
      realizedPnL = pf.realizedPnl;
      unrealizedPnL = pf.unrealizedPnl;
      holdings = pf.positions.map((p) => ({
        symbol: p.symbol, qty: p.quantity, avgPrice: p.entryPrice, price: p.currentPrice,
        value: p.quantity * p.currentPrice, pnl: p.unrealizedPnl,
      }));
      positions = pf.positions.map((p) => ({
        symbol: p.symbol, side: p.side, qty: p.quantity, entry: p.entryPrice, mark: p.currentPrice,
        unrealizedPnl: p.unrealizedPnl, leverage: 1,
      }));
    } else if (portfolioAgent && typeof (portfolioAgent as any).getPortfolio === "function") {
      const pnl = (portfolioAgent as any).getPnL();
      const positionsArray = (portfolioAgent as any).getPositionsArray() ?? [];
      totalValue = pnl.totalValue; availableCash = pnl.cash; realizedPnL = pnl.realizedPnL; unrealizedPnL = pnl.unrealizedPnL;
      holdings = positionsArray.map((p: any) => ({
        symbol: p.symbol, qty: p.qty, avgPrice: p.avgPrice, price: p.currentPrice,
        value: p.qty * p.currentPrice, pnl: (p.currentPrice - p.avgPrice) * p.qty,
      }));
      positions = positionsArray.map((p: any) => ({
        symbol: p.symbol, side: "long" as const, qty: p.qty, entry: p.avgPrice, mark: p.currentPrice,
        unrealizedPnl: (p.currentPrice - p.avgPrice) * p.qty, leverage: p.leverage ?? 1,
      }));
    } else {
      return reply.status(503).send({ error: "portfolio not available", code: "PORTFOLIO_NOT_READY" });
    }

    const totalPnl = realizedPnL + unrealizedPnL;
    return {
      timestamp: Date.now(),
      baseCurrency: "USDT",
      totalValue,
      availableCash,
      pnl: {
        day: realizedPnL,
        week: 0,
        total: totalPnl,
        percentDay: totalValue > 0 ? (totalPnl / totalValue) * 100 : 0,
      },
      holdings,
      positions,
      risk: riskMetrics ? {
        exposure: riskMetrics.exposure / 100,
        maxDrawdown: riskMetrics.drawdown / 100,
        sharpe: riskMetrics.sharpe,
        status: "ok" as const,
      } : { exposure: 0, maxDrawdown: 0, sharpe: 0, status: "ok" as const },
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/market/ticks
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { limit?: string; symbol?: string } }>(
    "/api/market/ticks",
    async (request) => {
      const limitRaw = request.query.limit;
      let limit = 20;
      if (limitRaw !== undefined) {
        const parsed = parseInt(limitRaw, 10);
        if (!Number.isNaN(parsed) && parsed > 0 && parsed <= 100) {
          limit = parsed;
        }
      }

      const runtime = getRuntime();
      if (runtime) {
        const marketAgent = runtime.getAgentRegistry().get("market");
        if (marketAgent && typeof (marketAgent as any).getHistory === "function") {
          let ticks = (marketAgent as any).getHistory(limit, request.query.symbol);
          return { ticks, timestamp: Date.now() };
        }
      }

      // Fallback: empty ticks
      return { ticks: [], timestamp: Date.now() };
    },
  );

  // -------------------------------------------------------------------------
  // GET /api/signals
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { limit?: string } }>("/api/signals", async (request) => {
    const runtime = getRuntime();
    if (!runtime) return { signals: [] };
    const quantAgent = runtime.getAgentRegistry().get("quant");
    if (!quantAgent || typeof (quantAgent as any).getSignals !== "function") {
      return { signals: [] };
    }
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 20;
    return { signals: (quantAgent as any).getSignals(limit) };
  });

  // -------------------------------------------------------------------------
  // GET /api/orders — single truth: PaperBroker (real orders), fallback PortfolioAgent
  // GET /api/trades — single truth: PaperBroker fills + ExecutionAgent, fallback PortfolioAgent
  // -------------------------------------------------------------------------
  app.get("/api/orders", async () => {
    const broker = getPaperBroker();
    if (broker) return { orders: broker.getOrderHistory(), source: "paper-broker" };
    const runtime = getRuntime();
    if (!runtime) return { orders: [] };
    const portfolioAgent = runtime.getAgentRegistry().get("portfolio");
    if (!portfolioAgent || typeof (portfolioAgent as any).getOrderHistory !== "function") {
      return { orders: [] };
    }
    return { orders: (portfolioAgent as any).getOrderHistory(), source: "portfolio-agent" };
  });

  app.get("/api/trades", async () => {
    const broker = getPaperBroker();
    // Prefer broker history would be trades, but broker tracks orders; execution agent tracks fills
    const runtime = getRuntime();
    const execAgent = runtime?.getAgentRegistry().get("execution");
    if (execAgent && typeof (execAgent as any).getFills === "function") {
      return { trades: (execAgent as any).getFills(100), source: "execution-agent" };
    }
    if (broker) {
      // broker.getOrderHistory includes filled orders with filledPrice/fee — map to trades shape
      const filled = broker.getOrderHistory().filter((o: any) => o.status === "filled").map((o: any) => ({
        symbol: o.symbol, side: o.side, qty: o.quantity, price: o.filledPrice ?? o.price,
        fee: o.fee ?? 0, timestamp: o.filledAt ?? o.createdAt, orderId: o.id,
      }));
      return { trades: filled, source: "paper-broker" };
    }
    if (!runtime) return { trades: [] };
    const portfolioAgent = runtime.getAgentRegistry().get("portfolio");
    if (!portfolioAgent || typeof (portfolioAgent as any).getFillHistory !== "function") {
      return { trades: [] };
    }
    return { trades: (portfolioAgent as any).getFillHistory(), source: "portfolio-agent-fallback" };
  });

  // -------------------------------------------------------------------------
  // GET /api/execution/status
  // -------------------------------------------------------------------------
  app.get("/api/execution/status", async () => {
    const runtime = getRuntime();
    if (!runtime) return { execution: null };
    const execAgent = runtime.getAgentRegistry().get("execution");
    if (!execAgent || typeof (execAgent as any).getStats !== "function") {
      return { execution: null };
    }
    return { execution: (execAgent as any).getStats() };
  });

  // -------------------------------------------------------------------------
  // GET /api/state
  // -------------------------------------------------------------------------
  app.get("/api/state", async (_request, reply) => {
    try {
      const recentEvents = bus.getHistory(undefined, 100);
      const runtime = getRuntime();
      const health = runtime ? await runtime.getHealth() : null;
      return {
        recentEvents,
        eventCount: bus.size(),
        subscriberCount: bus.subscriberCount(),
        runtime: health ? {
          status: health.status,
          agents: health.agents,
          tools: health.components.tools,
          strategies: health.components.strategies,
        } : null,
        timestamp: Date.now(),
      };
    } catch (err) {
      app.log.error({ err }, "GET /api/state failed");
      return reply.status(500).send({ error: "failed to load state" });
    }
  });

  // -------------------------------------------------------------------------
  // POST /api/publish
  // -------------------------------------------------------------------------
  app.post<{
    Body: {
      type?: string;
      data?: unknown;
      channelId?: string;
      threadId?: string;
      agentId?: string;
      runId?: string;
      id?: string;
      timestamp?: number;
    };
  }>("/api/publish", async (request, reply) => {
    const body = request.body;

    if (!body || typeof body !== "object") {
      return reply.status(400).send({ error: "invalid body, expected JSON object" });
    }

    if (!body.type || typeof body.type !== "string" || body.type.trim() === "") {
      return reply.status(400).send({ error: "field 'type' is required and must be a non-empty string" });
    }

    try {
      const event = bus.publish({
        id: body.id,
        type: body.type.trim(),
        data: body.data ?? null,
        timestamp: body.timestamp,
        source: "api-publish",
        channelId: body.channelId,
        threadId: body.threadId,
        agentId: body.agentId,
        runId: body.runId,
      });

      app.log.info({ eventId: event.id, type: event.type }, "event published");
      return reply.status(201).send({ ok: true, event });
    } catch (err) {
      app.log.error({ err }, "publish failed");
      return reply.status(500).send({ error: "failed to publish event" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/events (SSE)
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: {
      channelId?: string;
      threadId?: string;
      agentId?: string;
      type?: string;
      runId?: string;
      replay?: string;
      limit?: string;
      lastEventId?: string;
    };
  }>("/api/events", async (request, reply) => {
    const filter: HistoryFilter = {};
    if (request.query.channelId) filter.channelId = request.query.channelId;
    if (request.query.threadId) filter.threadId = request.query.threadId;
    if (request.query.agentId) filter.agentId = request.query.agentId;
    if (request.query.type) filter.type = request.query.type;
    if (request.query.runId) filter.runId = request.query.runId;

    let sinceTimestamp: number | undefined;
    if (request.query.lastEventId) {
      const found = bus.getHistory().find((e) => e.id === request.query.lastEventId);
      if (found) {
        sinceTimestamp = found.timestamp + 1;
        filter.since = sinceTimestamp;
      }
    }

    const shouldReplay = request.query.replay !== "false";
    let replayLimit: number | undefined;
    if (request.query.limit) {
      const parsed = parseInt(request.query.limit, 10);
      if (!Number.isNaN(parsed) && parsed >= 0) {
        replayLimit = parsed;
      }
    }

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      "Access-Control-Allow-Origin": "*",
    });

    const sendEvent = (event: { id: string; type: string; data: unknown; timestamp: number }) => {
      try {
        reply.raw.write(`id: ${event.id}\n`);
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify({ ...event })}\n\n`);
      } catch (err) {
        app.log.warn({ err }, "failed to write SSE event");
      }
    };

    const sendComment = (comment: string) => {
      try {
        reply.raw.write(`: ${comment}\n\n`);
      } catch {}
    };

    sendComment("connected");
    if (typeof (reply.raw as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
      try {
        (reply.raw as unknown as { flushHeaders: () => void }).flushHeaders();
      } catch {}
    }

    if (shouldReplay) {
      const history = bus.getHistory(Object.keys(filter).length > 0 ? filter : undefined, replayLimit);
      for (const ev of history) {
        sendEvent(ev);
      }
      sendComment("replay-complete");
    }

    const handler = (event: FinanceEvent) => {
      if (filter.type && event.type !== filter.type) return;
      if (filter.channelId && event.channelId !== filter.channelId) return;
      if (filter.threadId && event.threadId !== filter.threadId) return;
      if (filter.agentId && event.agentId !== filter.agentId) return;
      if (filter.runId && event.runId !== filter.runId) return;
      sendEvent(event);
    };

    const unsubscribe = bus.subscribe(handler);

    const heartbeat = setInterval(() => {
      sendComment(`heartbeat ${Date.now()}`);
    }, 15_000);

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      app.log.info("SSE client disconnected");
    };

    request.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
    reply.raw.on("error", (err: unknown) => {
      app.log.warn({ err }, "SSE raw error");
      cleanup();
    });

    await new Promise<void>((resolve) => {
      request.raw.on("close", () => resolve());
      reply.raw.on("close", () => resolve());
    });

    cleanup();
  });

  // -------------------------------------------------------------------------
  // POST /api/gateway/trade — submit trade through gateway
  // -------------------------------------------------------------------------
  app.post<{
    Body: {
      symbol?: string;
      side?: string;
      type?: string;
      quantity?: number;
      price?: number;
      strategy?: string;
      agentId?: string;
    };
  }>("/api/gateway/trade", async (request, reply) => {
    const gw = getGateway();
    if (!gw) return reply.status(503).send({ error: "gateway not available" });
    const body = request.body;
    if (!body?.symbol || !body?.side || typeof body?.quantity !== "number" || typeof body?.price !== "number") {
      return reply.status(400).send({ error: "symbol, side, quantity, price are required" });
    }
    try {
      const decision = await gw.submitRequest({
        symbol: body.symbol,
        side: body.side as "buy" | "sell",
        type: (body.type as "market" | "limit") ?? "market",
        quantity: body.quantity,
        price: body.price,
        strategy: body.strategy,
        agentId: body.agentId ?? "api",
      });
      return { decision };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/gateway/stats
  // -------------------------------------------------------------------------
  app.get("/api/gateway/stats", async () => {
    const gw = getGateway();
    return { gateway: gw ? gw.getStats() : null };
  });

  // -------------------------------------------------------------------------
  // GET /api/market/state
  // -------------------------------------------------------------------------
  app.get("/api/market/state", async () => {
    const ms = getMarketState();
    return { marketState: ms ? ms.getSnapshot() : null };
  });

  // -------------------------------------------------------------------------
  // GET /api/market/candles
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: { symbol?: string; timeframe?: string; limit?: string };
  }>("/api/market/candles", async (request) => {
    const symbol = (request.query.symbol ?? "BTCUSDT").toUpperCase();
    const limit = Math.min(parseInt(request.query.limit ?? "100", 10), 500);
    const ms = getMarketState();
    const price = ms?.getPrice(symbol);

    if (!price) {
      // TODO: fetch real candle data from exchange adapter when market state has no price yet
      return { candles: [], symbol, timeframe: request.query.timeframe ?? "1m", timestamp: Date.now(), note: "No price data available for this symbol" };
    }

    // TODO: replace synthetic candles with real historical data from BinanceAdapter
    const now = Date.now();
    const candles = Array.from({ length: limit }, (_, i) => {
      const change = (Math.random() - 0.5) * price * 0.02;
      const open = price + change;
      const high = open + Math.abs(change) * 0.5;
      const low = open - Math.abs(change) * 0.5;
      const close = low + Math.random() * (high - low);
      return {
        symbol,
        timeframe: request.query.timeframe ?? "1m",
        open: Math.round(open * 100) / 100,
        high: Math.round(high * 100) / 100,
        low: Math.round(low * 100) / 100,
        close: Math.round(close * 100) / 100,
        volume: Math.round(Math.random() * 1000 * 100) / 100,
        timestamp: now - (limit - i) * 60_000,
      };
    });
    // TODO: candles are synthetic — real historical candle storage needed (Phase 6/7)
    return { candles, symbol, timeframe: request.query.timeframe ?? "1m", timestamp: Date.now(), synthetic: true };
  });

  // -------------------------------------------------------------------------
  // GET /api/market/orderbook
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: { symbol?: string; depth?: string };
  }>("/api/market/orderbook", async (request) => {
    const symbol = (request.query.symbol ?? "BTCUSDT").toUpperCase();
    const depth = parseInt(request.query.depth ?? "10", 10);
    const ms = getMarketState();
    const mid = ms?.getPrice(symbol);

    if (!mid) {
      return { symbol, bids: [], asks: [], timestamp: Date.now(), note: "No price data available" };
    }

    // TODO: replace with real orderbook data from BinanceAdapter WebSocket
    const bids = Array.from({ length: depth }, (_, i) => ({
      price: Math.round(mid * (1 - (i + 1) * 0.0001) * 100) / 100,
      quantity: Math.round(Math.random() * 10 * 1000) / 1000,
    }));
    const asks = Array.from({ length: depth }, (_, i) => ({
      price: Math.round(mid * (1 + (i + 1) * 0.0001) * 100) / 100,
      quantity: Math.round(Math.random() * 10 * 1000) / 1000,
    }));
    return { symbol, bids, asks, timestamp: Date.now(), synthetic: true };
  });

  // -------------------------------------------------------------------------
  // POST /api/strategies — register a new strategy
  // -------------------------------------------------------------------------
  app.post<{
    Body: { id?: string; name?: string; enabled?: boolean };
  }>("/api/strategies", async (request, reply) => {
    const registry = getStrategyRegistry();
    if (!registry) return reply.status(503).send({ error: "strategy registry not available" });
    const body = request.body;
    if (!body?.id || !body?.name) {
      return reply.status(400).send({ error: "id and name are required" });
    }
    // Check if already exists
    if (registry.get(body.id)) {
      return reply.status(409).send({ error: `Strategy '${body.id}' already exists` });
    }
    registry.register({
      config: {
        id: body.id,
        name: body.name,
        version: "1.0.0",
        description: body.name,
        enabled: body.enabled ?? true,
        timeframe: "tick",
        parameters: {},
      },
      calculate: () => ({ side: "hold" as const, confidence: 0.5, indicators: {}, reasoning: "placeholder" }),
    });
    return { ok: true, strategy: { id: body.id, name: body.name } };
  });

  // -------------------------------------------------------------------------
  // POST /api/strategies/:id/toggle — enable/disable
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/strategies/:id/toggle", async (request, reply) => {
    const registry = getStrategyRegistry();
    if (!registry) return reply.status(503).send({ error: "strategy registry not available" });
    const strategy = registry.get(request.params.id);
    if (!strategy) return reply.status(404).send({ error: "strategy not found" });
    if (strategy.config.enabled) {
      registry.disable(request.params.id);
    } else {
      registry.enable(request.params.id);
    }
    return { ok: true, enabled: !strategy.config.enabled };
  });

  // -------------------------------------------------------------------------
  // GET /api/audit
  // -------------------------------------------------------------------------
  app.get<{
    Querystring: { eventType?: string; agentId?: string; limit?: string };
  }>("/api/audit", async (request) => {
    const logger = getAuditLogger();
    if (!logger) return { records: [] };
    return {
      records: logger.getRecords({
        eventType: request.query.eventType,
        agentId: request.query.agentId,
        limit: request.query.limit ? parseInt(request.query.limit, 10) : 50,
      }),
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/portfolio/positions — single truth: PaperBroker
  // -------------------------------------------------------------------------
  app.get("/api/portfolio/positions", async () => {
    const broker = getPaperBroker();
    if (broker) {
      const pf = broker.getPortfolio();
      return { positions: pf.positions.map((p) => ({ symbol: p.symbol, qty: p.quantity, entryPrice: p.entryPrice, currentPrice: p.currentPrice, unrealizedPnl: p.unrealizedPnl })), source: "paper-broker" };
    }
    const runtime = getRuntime();
    if (!runtime) return { positions: [] };
    const portfolioAgent = runtime.getAgentRegistry().get("portfolio");
    if (!portfolioAgent || typeof (portfolioAgent as any).getPositionsArray !== "function") {
      return { positions: [] };
    }
    return { positions: (portfolioAgent as any).getPositionsArray(), source: "portfolio-agent" };
  });

  // -------------------------------------------------------------------------
  // GET /api/portfolio/history
  // -------------------------------------------------------------------------
  app.get("/api/portfolio/history", async () => {
    const runtime = getRuntime();
    if (!runtime) return { snapshots: [] };
    // TODO: fetch from state recovery or database
    return { snapshots: [], note: "TODO: implement portfolio history persistence" };
  });

  // -------------------------------------------------------------------------
  // GET /api/portfolio/allocation
  // -------------------------------------------------------------------------
  app.get("/api/portfolio/allocation", async () => {
    const runtime = getRuntime();
    if (!runtime) return { allocation: {} };
    const portfolioAgent = runtime.getAgentRegistry().get("portfolio");
    if (!portfolioAgent || typeof (portfolioAgent as any).getAllocation !== "function") {
      return { allocation: {} };
    }
    return { allocation: (portfolioAgent as any).getAllocation() };
  });

  // -------------------------------------------------------------------------
  // GET /api/orders/:id
  // -------------------------------------------------------------------------
  app.get<{ Params: { id: string } }>("/api/orders/:id", async (request, reply) => {
    const runtime = getRuntime();
    if (!runtime) return reply.status(404).send({ error: "order not found" });
    const portfolioAgent = runtime.getAgentRegistry().get("portfolio");
    if (!portfolioAgent || typeof (portfolioAgent as any).getOrderHistory !== "function") {
      return reply.status(404).send({ error: "order not found" });
    }
    const orders = (portfolioAgent as any).getOrderHistory();
    const order = orders.find((o: { id?: string; orderId?: string }) => o.id === request.params.id || o.orderId === request.params.id);
    if (!order) return reply.status(404).send({ error: "order not found" });
    return { order };
  });

  // -------------------------------------------------------------------------
  // POST /api/orders/:id/cancel
  // -------------------------------------------------------------------------
  app.post<{ Params: { id: string } }>("/api/orders/:id/cancel", async (request, reply) => {
    const runtime = getRuntime();
    if (!runtime) return reply.status(503).send({ error: "runtime not available" });
    const execAgent = runtime.getAgentRegistry().get("execution");
    if (!execAgent) return reply.status(503).send({ error: "execution agent not available" });
    // Emit cancel event
    runtime.getEventBus().publish({
      type: "order.cancelled",
      data: { orderId: request.params.id, timestamp: Date.now() },
      source: "api",
    });
    return { ok: true, orderId: request.params.id, status: "cancelled" };
  });

  // -------------------------------------------------------------------------
  // GET /api/risk/metrics
  // -------------------------------------------------------------------------
  app.get("/api/risk/metrics", async () => {
    const runtime = getRuntime();
    if (!runtime) return { metrics: null };
    const riskAgent = runtime.getAgentRegistry().get("risk");
    if (!riskAgent || typeof (riskAgent as any).getRiskMetrics !== "function") {
      return { metrics: null };
    }
    return { metrics: (riskAgent as any).getRiskMetrics() };
  });

  // -------------------------------------------------------------------------
  // POST /api/trading/signal — manually trigger a signal
  // -------------------------------------------------------------------------
  app.post<{
    Body: { symbol?: string; action?: string; price?: number; confidence?: number };
  }>("/api/trading/signal", async (request, reply) => {
    const runtime = getRuntime();
    if (!runtime) return reply.status(503).send({ error: "runtime not available" });
    const body = request.body;
    if (!body?.symbol || !body?.action || typeof body?.price !== "number") {
      return reply.status(400).send({ error: "symbol, action, price are required" });
    }
    runtime.getEventBus().publish({
      type: "quant.signal",
      data: {
        id: `manual-${Date.now()}`,
        symbol: body.symbol.toUpperCase(),
        action: body.action,
        confidence: body.confidence ?? 0.7,
        price: body.price,
        timestamp: Date.now(),
        reason: "Manual signal from API",
        strategy: "manual",
        timeframe: "tick",
        indicators: {},
      },
      source: "api",
      agentId: "api",
    });
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // POST /api/backtest/run — OpenBot-finance: run strategy backtest
  // -------------------------------------------------------------------------
  app.post<{
    Body: { strategyId?: string; symbol?: string; timeframe?: string; candles?: number };
  }>("/api/backtest/run", async (request, reply) => {
    const registry = getStrategyRegistry();
    if (!registry) return reply.status(503).send({ error: "strategy registry not available" });
    const body = request.body ?? {};
    const strategyId = body.strategyId ?? registry.list()[0]?.id;
    if (!strategyId) return reply.status(400).send({ error: "strategyId required and no strategies registered" });
    const instance = registry.get(strategyId);
    if (!instance) return reply.status(404).send({ error: `strategy '${strategyId}' not found` });

    const symbol = (body.symbol ?? "BTCUSDT").toUpperCase();
    const timeframe = body.timeframe ?? "1m";
    const limit = Math.min(body.candles ?? 200, 1000);

    // Build synthetic candles from current price for demo — replace with DB/history in prod
    const ms = getMarketState();
    const basePrice = ms?.getPrice(symbol) ?? 68000;
    const now = Date.now();
    const candles = Array.from({ length: limit }, (_, i) => {
      const drift = (Math.random() - 0.5) * basePrice * 0.01;
      const open = basePrice + drift;
      const close = open + (Math.random() - 0.5) * open * 0.005;
      return {
        open, high: Math.max(open, close) * 1.002,
        low: Math.min(open, close) * 0.998,
        close, volume: Math.random() * 1000,
        timestamp: now - (limit - i) * 60000,
      };
    });

    try {
      const { BacktestEngine } = await import("../backtesting/backtest-engine.js");
      const engine = new BacktestEngine();
      const result = engine.run(instance as any, candles as any, symbol, timeframe);
      return { ok: true, result };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/backtest/strategies", async () => {
    const registry = getStrategyRegistry();
    if (!registry) return { strategies: [] };
    return { strategies: registry.list().map((s) => ({ id: s.id, name: s.name, enabled: s.enabled })) };
  });

  // -------------------------------------------------------------------------
  // 404 & error handling
  // -------------------------------------------------------------------------
  app.setNotFoundHandler((request, reply) => {
    return reply.status(404).send({
      error: "not found",
      path: request.url,
      method: request.method,
    });
  });

  app.setErrorHandler((error, _request, reply) => {
    app.log.error({ err: error }, "unhandled error");
    const status = (error as unknown as { statusCode?: number }).statusCode ?? 500;
    const message = error instanceof Error ? error.message : "internal server error";
    return reply.status(status).send({ error: message, statusCode: status });
  });

  return app;
}

export async function startServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const port = opts.port ?? (process.env.PORT ? parseInt(process.env.PORT, 10) : 4132);
  const host = opts.host ?? process.env.HOST ?? "0.0.0.0";

  const app = await buildServer({ ...opts, port, host });

  await app.listen({ port, host });
  app.log.info(`Finance Agent OS server listening on http://${host}:${port}`);

  return app;
}

export default buildServer;
