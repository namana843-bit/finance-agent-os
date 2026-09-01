import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { EventBus, eventBus, type HistoryFilter } from "./eventBus.js";
import { Storage, storage } from "./storage.js";

// ---------------------------------------------------------------------------
// Mock data helpers (replace with real broker integrations)
// ---------------------------------------------------------------------------

function mockPortfolio() {
  const now = Date.now();
  return {
    timestamp: now,
    baseCurrency: "USDT",
    totalValue: 125_430.22,
    availableCash: 42_100.5,
    pnl: {
      day: 1_240.33,
      week: 3_890.12,
      total: 12_543.22,
      percentDay: 0.99,
    },
    holdings: [
      { symbol: "BTCUSDT", qty: 0.85, avgPrice: 62_000, price: 68_120.5, value: 57_902.42, pnl: 5_202.42 },
      { symbol: "ETHUSDT", qty: 12.5, avgPrice: 3_200, price: 3_450.12, value: 43_126.5, pnl: 3_126.5 },
      { symbol: "SOLUSDT", qty: 150, avgPrice: 140, price: 162.68, value: 24_401.3, pnl: 3_401.3 },
    ],
    positions: [
      { symbol: "BTCUSDT", side: "long" as const, qty: 0.85, entry: 62_000, mark: 68_120.5, unrealizedPnl: 5_202.42, leverage: 1 },
    ],
    risk: {
      exposure: 0.68,
      maxDrawdown: 0.12,
      sharpe: 1.42,
      status: "ok" as const,
    },
  };
}

function mockTicks(count = 20) {
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
  const now = Date.now();
  return Array.from({ length: count }, (_, i) => {
    const symbol = symbols[i % symbols.length]!;
    const base =
      symbol === "BTCUSDT"
        ? 68_000
        : symbol === "ETHUSDT"
          ? 3_400
          : symbol === "SOLUSDT"
            ? 160
            : symbol === "BNBUSDT"
              ? 600
              : 0.52;
    const volatility = base * 0.002;
    const price = base + (Math.random() - 0.5) * volatility * 10;
    const change = (Math.random() - 0.5) * 2;
    return {
      symbol,
      price: Number(price.toFixed(2)),
      change: Number(change.toFixed(2)),
      changePercent: Number(((change / base) * 100).toFixed(3)),
      volume: Number((Math.random() * 1000 + 100).toFixed(2)),
      timestamp: now - (count - i) * 1000,
    };
  });
}

// ---------------------------------------------------------------------------
// Server factory
// ---------------------------------------------------------------------------

export interface ServerOptions {
  port?: number;
  host?: string;
  bus?: EventBus;
  store?: Storage;
  logger?: boolean;
}

export async function buildServer(opts: ServerOptions = {}): Promise<FastifyInstance> {
  const bus = opts.bus ?? eventBus;
  const store = opts.store ?? storage;

  const app = Fastify({
    logger: opts.logger ?? true,
  });

  await app.register(cors, {
    origin: true,
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  // Ensure storage is ready + seeded
  await store.ensureDir().catch((err) => {
    app.log.warn({ err }, "failed to ensure .data dir");
  });
  await store.seedIfEmpty().catch((err) => {
    app.log.warn({ err }, "failed to seed storage");
  });

  // -------------------------------------------------------------------------
  // GET /api/health
  // -------------------------------------------------------------------------
  app.get("/api/health", async () => {
    return {
      status: "ok",
      uptime: process.uptime(),
      timestamp: Date.now(),
      version: "0.1.0",
    };
  });

  // -------------------------------------------------------------------------
  // GET /api/state
  // -------------------------------------------------------------------------
  app.get("/api/state", async (_request, reply) => {
    try {
      const state = await store.getState();
      const recentEvents = bus.getHistory(undefined, 100);
      return {
        ...state,
        recentEvents,
        eventCount: bus.size(),
        subscriberCount: bus.subscriberCount(),
        timestamp: Date.now(),
      };
    } catch (err) {
      app.log.error({ err }, "GET /api/state failed");
      return reply.status(500).send({ error: "failed to load state" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/portfolio
  // -------------------------------------------------------------------------
  app.get("/api/portfolio", async () => {
    // In production this would aggregate from portfolio agent / broker
    return mockPortfolio();
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
      let ticks = mockTicks(limit);
      if (request.query.symbol) {
        const sym = request.query.symbol.toUpperCase();
        ticks = ticks.filter((t) => t.symbol === sym);
        // If filtered empty but symbol requested, generate mock for that symbol
        if (ticks.length === 0) {
          ticks = mockTicks(limit).map((t) => ({ ...t, symbol: sym }));
        }
      }
      return { ticks, timestamp: Date.now() };
    },
  );

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
        channelId: body.channelId,
        threadId: body.threadId,
        agentId: body.agentId,
        runId: body.runId,
      });

      // Fire-and-forget persistence as a message if channel/thread context exists
      // (non-blocking, don't fail publish if storage fails)
      if (event.channelId && event.threadId) {
        store
          .appendMessage({
            id: event.id,
            channelId: event.channelId,
            threadId: event.threadId,
            role: event.agentId ?? "user",
            content: typeof event.data === "string" ? event.data : JSON.stringify(event.data),
            timestamp: event.timestamp,
            agentId: event.agentId,
            data: event.data,
          })
          .catch((err) => {
            app.log.warn({ err, eventId: event.id }, "failed to persist message");
          });
      }

      app.log.info({ eventId: event.id, type: event.type }, "event published");

      return reply.status(201).send({ ok: true, event });
    } catch (err) {
      app.log.error({ err }, "publish failed");
      return reply.status(500).send({ error: "failed to publish event" });
    }
  });

  // -------------------------------------------------------------------------
  // GET /api/events  (SSE)
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
    // Build filter from query params
    const filter: HistoryFilter = {};
    if (request.query.channelId) filter.channelId = request.query.channelId;
    if (request.query.threadId) filter.threadId = request.query.threadId;
    if (request.query.agentId) filter.agentId = request.query.agentId;
    if (request.query.type) filter.type = request.query.type;
    if (request.query.runId) filter.runId = request.query.runId;

    // lastEventId support (OpenBot-style resume)
    // If provided, replay events after that id's timestamp
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

    // Setup SSE headers
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      // CORS headers are already handled by @fastify/cors but ensure SSE works cross-origin
      "Access-Control-Allow-Origin": "*",
    });

    // Helper to send SSE formatted event
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

    // Send initial comment to establish connection
    sendComment("connected");
    if (typeof (reply.raw as unknown as { flushHeaders?: () => void }).flushHeaders === "function") {
      try {
        (reply.raw as unknown as { flushHeaders: () => void }).flushHeaders();
      } catch {}
    }

    // Replay history if requested
    if (shouldReplay) {
      const history = bus.getHistory(Object.keys(filter).length > 0 ? filter : undefined, replayLimit);
      for (const ev of history) {
        sendEvent(ev);
      }
      // Signal replay complete
      sendComment("replay-complete");
    }

    // Subscribe to live events
    const handler = (event: import("./eventBus.js").FinanceEvent) => {
      // Apply filter to live events as well
      if (filter.type && event.type !== filter.type) return;
      if (filter.channelId && event.channelId !== filter.channelId) return;
      if (filter.threadId && event.threadId !== filter.threadId) return;
      if (filter.agentId && event.agentId !== filter.agentId) return;
      if (filter.runId && event.runId !== filter.runId) return;
      sendEvent(event);
    };

    const unsubscribe = bus.subscribe(handler);

    // Heartbeat every 15s to keep connection alive (infrastructure / proxies)
    const heartbeat = setInterval(() => {
      sendComment(`heartbeat ${Date.now()}`);
    }, 15_000);

    // Cleanup on client disconnect
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

    // Keep request open — do not end reply. Fastify will not auto-close because we used reply.raw.writeHead
    // Return a never-resolving promise that resolves on close to satisfy Fastify's async handler
    await new Promise<void>((resolve) => {
      request.raw.on("close", () => resolve());
      reply.raw.on("close", () => resolve());
    });

    // Unreachable cleanup already done, but ensure
    cleanup();
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
    const status =
      (error as unknown as { statusCode?: number }).statusCode ?? 500;
    const message =
      error instanceof Error ? error.message : "internal server error";
    return reply.status(status).send({
      error: message,
      statusCode: status,
    });
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
