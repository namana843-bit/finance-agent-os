import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import { TypedEventBus, type EventBusOptions } from "@finance/core";
import type { FinanceEvent, HistoryFilter } from "@finance/shared";
import { getRuntime, getGateway, getAuditLogger, getMarketState, getStrategyRegistry, getPaperBroker, getClineGateway, getOpencodeGateway, getChat, getApprovals, getLlm, getDialogueEngine, getProviderRegistry, getEngineManager, getFinanceToolRegistry, getAgentRuntime, getAgentMemory, getCliManager } from "./runtime.js";
import { ApprovalError } from "../approvals/types.js";
import { COWORKER_TEMPLATES, buildCoworkerValidationDeps, sanitizeBotInput, templateSystemPrompt, validateCoworkerInput } from "../coworkers/index.js";
import { isBuiltInAgent } from "../llm/agent-runtime.js";
import type { LlmConfig } from "../llm/types.js";
import { CustomBotAgent } from "../agents/custom-bot-agent.js";

// Union-tolerant view: works with the current single-provider LlmConfig and
// with the parallel agent's discriminated union
// (openai-compat | cli). Narrow with cfg.provider === "cli".
type CliEngineConfig = { provider: "cli"; command: string; model?: string; args?: string[] };
type AnyLlmConfig = LlmConfig | CliEngineConfig;

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

  const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? process.env.CORS_ORIGINS ?? "http://localhost:3000,http://localhost:5173").split(",").map((s) => s.trim()).filter(Boolean);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin) || allowedOrigins.includes("*")) return cb(null, true);
      return cb(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
  });

  // -------------------------------------------------------------------------
  // GET /.well-known/finance-agent/environment (for verifyPhoneEndpoint & isWorkspaceRunning)
  // -------------------------------------------------------------------------
  app.get("/.well-known/finance-agent/environment", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const dataDir = process.env.FINANCE_DATA_DIR || process.env.OMB_DATA_DIR || join(homedir(), ".finance-agent");
    let environmentId: string | null = null;
    try {
      const raw = readFileSync(join(dataDir, "environment-id"), "utf8").trim();
      if (/^[0-9a-f-]{36}$/i.test(raw)) environmentId = raw;
    } catch { /* no id yet */ }
    return { environmentId, app: "finance-agent", version: "0.1.0", platform: process.platform, label: process.env.FINANCE_LABEL ?? null };
  });
  // legacy alias for OpenMausBot compat
  app.get("/.well-known/openmausbot/environment", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");
    const dataDir = process.env.FINANCE_DATA_DIR || process.env.OMB_DATA_DIR || join(homedir(), ".finance-agent");
    let environmentId: string | null = null;
    try {
      const raw = readFileSync(join(dataDir, "environment-id"), "utf8").trim();
      if (/^[0-9a-f-]{36}$/i.test(raw)) environmentId = raw;
    } catch {}
    return { environmentId, app: "finance-agent", version: "0.1.0", platform: process.platform, label: process.env.FINANCE_LABEL ?? null };
  });

  // -------------------------------------------------------------------------
  // GET /api/health
  // -------------------------------------------------------------------------
  app.get("/api/health", async () => {
    const runtime = getRuntime();
    const health = runtime ? await runtime.getHealth() : null;
    return {
      status: "ok",
      pid: process.pid,
      app: "finance-agent",
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
    const deniedPrefixes = ["supervisor.", "risk.", "gateway.", "order.", "trade.proposal_", "audit.kill_switch", "opencode.", "cline.", "cli."];
    const ttype = body.type.trim();
    if (deniedPrefixes.some((p) => ttype.startsWith(p))) {
      return reply.status(403).send({ error: "event type '" + ttype + "' is not allowed via /api/publish" });
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
  // Cline CLI Path Gateways (PRIMARY) — permissioned path gateways for `cline`
  // -------------------------------------------------------------------------
  app.get("/api/cline/cli-path", async () => {
    const gw = getClineGateway();
    if (!gw) return { cliPath: null, error: "cline gateway not available" };
    const info = await gw.getCliInfo();
    return { ...info, gateway: "cline-cli" };
  });

  app.get("/api/cline/gateway/stats", async () => {
    const gw = getClineGateway();
    return { gateway: gw ? gw.getStats() : null };
  });

  app.get("/api/cline/paths", async () => {
    const gw = getClineGateway();
    if (!gw) return { error: "cline gateway not available" };
    return gw.listPathGateways();
  });

  app.post<{
    Body: { command?: string; args?: string[]; agentId?: string; correlationId?: string };
  }>("/api/cline/run", async (request, reply) => {
    const cgw = getClineGateway();
    if (!cgw) return reply.status(503).send({ error: "cline gateway not available" });
    const body = request.body ?? {};
    // Keep a bare prompt as ONE arg (do NOT split free text on whitespace).
    const args = body.args ?? (body.command ? [body.command] : []);
    if (args.length === 0) {
      return reply.status(400).send({ error: "command or args required (e.g. {\"args\":[\"--version\"]})" });
    }
    try {
      const result = await cgw.run({
        command: body.command ?? args.join(" "),
        args,
        agentId: body.agentId ?? "api",
        correlationId: body.correlationId,
      });
      const status = result.gated.allowed ? (result.ok ? 200 : 500) : 403;
      return reply.status(status).send({ result });
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // OpenCode CLI Path Gateways (deprecated — kept for backward compatibility)
  // -------------------------------------------------------------------------
  app.get("/api/opencode/cli-path", async () => {
    const gw = getOpencodeGateway();
    if (!gw) return { cliPath: null, error: "opencode gateway not available" };
    const info = await gw.getCliInfo();
    return { ...info, gateway: "opencode-cli" };
  });

  app.get("/api/opencode/gateway/stats", async () => {
    const gw = getOpencodeGateway();
    return { gateway: gw ? gw.getStats() : null };
  });

  app.get("/api/opencode/paths", async () => {
    const gw = getOpencodeGateway();
    if (!gw) return { error: "opencode gateway not available" };
    return gw.listPathGateways();
  });

  app.get<{
    Querystring: { refresh?: string };
  }>("/api/opencode/models", async (request) => {
    const refresh = request.query?.refresh === "true" || request.query?.refresh === "1";
    const { getOpencodeModels } = await import("../llm/opencode-models.js");
    return getOpencodeModels({ refresh });
  });

  app.post<{
    Body: { model: string; agentId?: string; applyToAll?: boolean };
  }>("/api/opencode/models", async (request, reply) => {
    const { model, agentId, applyToAll } = request.body ?? {};
    if (!model || typeof model !== "string") {
      return reply.status(400).send({ error: "model is required" });
    }
    const { updateOpencodeProjectModel } = await import("../llm/opencode-models.js");
    const updated = await updateOpencodeProjectModel({ model, agentId, applyToAll });
    return { ok: true, data: updated };
  });

  app.get("/api/gateways", async () => {
    const gw = getGateway();
    const cgw = getClineGateway();
    const ogw = getOpencodeGateway();
    return {
      financeGateway: gw ? { stats: gw.getStats(), config: gw.getConfig() } : null,
      clineGateway: cgw ? cgw.listPathGateways() : null,
      opencodeGateway: ogw ? ogw.listPathGateways() : null,
      paths: {
        finance: ["/api/gateway/trade", "/api/gateway/stats"],
        cline: ["/api/cline/cli-path", "/api/cline/paths", "/api/cline/run", "/api/cline/gateway/stats"],
        opencode: ["/api/opencode/cli-path", "/api/opencode/paths", "/api/opencode/models", "/api/opencode/run", "/api/opencode/gateway/stats"],
      },
    };
  });

  app.post<{
    Body: { command?: string; args?: string[]; agentId?: string; correlationId?: string };
  }>("/api/opencode/run", async (request, reply) => {
    const ogw = getOpencodeGateway();
    if (!ogw) return reply.status(503).send({ error: "opencode gateway not available" });
    const body = request.body ?? {};
    const args = body.args ?? (body.command ? body.command.trim().split(/\s+/).filter(Boolean) : []);
    if (args.length === 0) {
      return reply.status(400).send({ error: "command or args required (e.g. {\"args\":[\"--version\"]})" });
    }
    try {
      const result = await ogw.run({
        command: body.command ?? args.join(" "),
        args,
        agentId: body.agentId ?? "api",
        correlationId: body.correlationId,
      });
      const status = result.gated.allowed ? (result.ok ? 200 : 500) : 403;
      return reply.status(status).send({ result });
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // Generic CLI adapter layer — adapter-agnostic (OpenCode is just one adapter).
  // The desktop UI discovers available CLIs here instead of hard-coding names.
  //
  // Trust model: same as every other route in this server (single-user
  // localhost app — no per-route auth). Process spawning is never exposed
  // directly: sessions run adapter-declared argv via the central runner
  // (no shell strings), env overrides pass the denied-key filter, and no
  // response payload ever includes environment values.
  // -------------------------------------------------------------------------

  const CLI_MAX_TIMEOUT_MS = 1_800_000; // 30 min
  const CLI_MAX_TASK_CHARS = 200_000;
  const CLI_MAX_ARGS = 50;
  const CLI_MAX_ARG_CHARS = 4_000;
  const CLI_MAX_ENV_KEYS = 50;
  const CLI_ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

  /** Clamp timeoutMs; returns null when the value is unusable. */  function normalizeCliTimeoutMs(value: unknown): number | undefined | null {
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
    return Math.min(Math.floor(value), CLI_MAX_TIMEOUT_MS);
  }

  function validateCliEnv(env: unknown): { ok: true; value?: Record<string, string> } | { ok: false; error: string } {
    if (env === undefined) return { ok: true };
    if (!env || typeof env !== "object" || Array.isArray(env)) {
      return { ok: false, error: "env must be an object of string to string" };
    }
    const entries = Object.entries(env as Record<string, unknown>);
    if (entries.length > CLI_MAX_ENV_KEYS) {
      return { ok: false, error: `env allows at most ${CLI_MAX_ENV_KEYS} keys` };
    }
    const value: Record<string, string> = {};
    for (const [key, val] of entries) {
      if (!CLI_ENV_KEY_RE.test(key) || key.length > 128) {
        return { ok: false, error: `invalid env key '${key.slice(0, 64)}'` };
      }
      if (typeof val !== "string" || val.length > 8_192) {
        return { ok: false, error: `invalid env value for '${key.slice(0, 64)}'` };
      }
      value[key] = val;
    }
    return { ok: true, value };
  }

  function validateCliArgs(args: unknown): { ok: true; value?: string[] } | { ok: false; error: string } {
    if (args === undefined) return { ok: true };
    if (!Array.isArray(args) || args.length > CLI_MAX_ARGS) {
      return { ok: false, error: `args must be an array of at most ${CLI_MAX_ARGS} strings` };
    }
    for (const arg of args) {
      if (typeof arg !== "string" || arg.length > CLI_MAX_ARG_CHARS) {
        return { ok: false, error: "each arg must be a string" };
      }
    }
    return { ok: true, value: args as string[] };
  }

  async function validateCliCwd(cwd: unknown): Promise<{ ok: true; value?: string } | { ok: false; error: string }> {
    if (cwd === undefined) return { ok: true };
    if (typeof cwd !== "string" || cwd.length === 0 || cwd.length > 1_024) {
      return { ok: false, error: "cwd must be a non-empty path string" };
    }
    try {
      const { stat } = await import("node:fs/promises");
      const st = await stat(cwd);
      if (!st.isDirectory()) return { ok: false, error: "cwd is not a directory" };
    } catch {
      return { ok: false, error: "cwd does not exist" };
    }
    return { ok: true, value: cwd };
  }

  app.get("/api/cli/adapters", async () => {
    const cli = getCliManager();
    const adapters = await Promise.all(
      cli.listMetadata().map(async (meta) => {
        let installation: unknown = null;
        try {
          installation = await cli.validate(meta.id);
        } catch {
          installation = null;
        }
        return { ...meta, installation };
      }),
    );
    return { adapters };
  });

  app.get<{ Params: { id: string } }>("/api/cli/adapters/:id", async (request, reply) => {
    const cli = getCliManager();
    const adapter = cli.get(request.params.id);
    if (!adapter) {
      return reply.status(404).send({ error: `unknown CLI adapter '${request.params.id}'` });
    }
    return { adapter: adapter.getMetadata(), installation: await cli.validate(request.params.id) };
  });

  app.post<{ Params: { id: string } }>("/api/cli/adapters/:id/validate", async (request, reply) => {
    const cli = getCliManager();
    if (!cli.has(request.params.id)) {
      return reply.status(404).send({ error: `unknown CLI adapter '${request.params.id}'` });
    }
    return { validation: await cli.validate(request.params.id, { force: true }) };
  });

  app.get("/api/cli/sessions", async () => {
    return { sessions: getCliManager().listSessions() };
  });

  app.post<{
    Body: { adapterId?: string; cwd?: string; env?: Record<string, string>; args?: string[]; timeoutMs?: number; mode?: string };
  }>("/api/cli/sessions", async (request, reply) => {
    const body = request.body ?? {};
    const adapterId = typeof body.adapterId === "string" ? body.adapterId.trim() : "";
    if (!adapterId) {
      return reply.status(400).send({ error: "adapterId is required" });
    }
    if (!getCliManager().has(adapterId)) {
      return reply.status(404).send({ error: `unknown CLI adapter '${adapterId}'` });
    }
    if (body.mode !== undefined && body.mode !== "one-shot" && body.mode !== "persistent") {
      return reply.status(400).send({ error: "mode must be 'one-shot' or 'persistent'" });
    }
    const timeoutMs = normalizeCliTimeoutMs(body.timeoutMs);
    if (timeoutMs === null) {
      return reply.status(400).send({ error: "timeoutMs must be a positive number" });
    }
    const cwd = await validateCliCwd(body.cwd);
    if (!cwd.ok) {
      return reply.status(400).send({ error: cwd.error });
    }
    const env = validateCliEnv(body.env);
    if (!env.ok) {
      return reply.status(400).send({ error: env.error });
    }
    const args = validateCliArgs(body.args);
    if (!args.ok) {
      return reply.status(400).send({ error: args.error });
    }
    try {
      const session = await getCliManager().start(adapterId, {
        ...(cwd.value !== undefined ? { cwd: cwd.value } : {}),
        ...(env.value !== undefined ? { env: env.value } : {}),
        ...(args.value !== undefined ? { args: args.value } : {}),
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        ...(body.mode !== undefined ? { mode: body.mode as "one-shot" | "persistent" } : {}),
      });
      return { session: session.getSummary() };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Unsupported mode / misconfigured adapter — caller error, not missing.
      return reply.status(400).send({ error: message });
    }
  });

  app.get<{ Params: { id: string } }>("/api/cli/sessions/:id", async (request, reply) => {
    const session = getCliManager().getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({ error: `unknown CLI session '${request.params.id}'` });
    }
    return { session: session.getSummary() };
  });

  app.post<{
    Params: { id: string };
    Body: { task?: string; model?: string; agentId?: string; timeoutMs?: number };
  }>("/api/cli/sessions/:id/tasks", async (request, reply) => {
    const body = request.body ?? {};
    const task = typeof body.task === "string" ? body.task : "";
    if (!task.trim()) {
      return reply.status(400).send({ error: "task is required" });
    }
    if (task.length > CLI_MAX_TASK_CHARS) {
      return reply.status(400).send({ error: `task allows at most ${CLI_MAX_TASK_CHARS} characters` });
    }
    for (const [key, cap] of [["model", 256], ["agentId", 256]] as const) {
      const value = (body as Record<string, unknown>)[key];
      if (value !== undefined && (typeof value !== "string" || value.length > cap)) {
        return reply.status(400).send({ error: `${key} must be a string of at most ${cap} characters` });
      }
    }
    const timeoutMs = normalizeCliTimeoutMs(body.timeoutMs);
    if (timeoutMs === null) {
      return reply.status(400).send({ error: "timeoutMs must be a positive number" });
    }
    const session = getCliManager().getSession(request.params.id);
    if (!session) {
      return reply.status(404).send({ error: `unknown CLI session '${request.params.id}'` });
    }
    if (session.isStopped || session.status === "failed") {
      return reply.status(409).send({ error: `CLI session '${request.params.id}' is ${session.status}` });
    }
    try {
      const result = await getCliManager().sendTask(request.params.id, {
        task,
        model: body.model,
        agentId: body.agentId,
        ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      });
      // result carries the normalized outcome: ok / exitCode / timedOut /
      // cancelled / error (auth, startup, timeout and protocol failures).
      return reply.status(result.ok ? 200 : 500).send({ result });
    } catch (err) {
      return reply.status(409).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete<{ Params: { id: string } }>("/api/cli/sessions/:id", async (request, reply) => {
    const cli = getCliManager();
    if (!cli.getSession(request.params.id)) {
      return reply.status(404).send({ error: `unknown CLI session '${request.params.id}'` });
    }
    await cli.stop(request.params.id, "stopped via API");
    return { ok: true, session: cli.getSession(request.params.id)?.getSummary() ?? null };
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
  // CHAT (Phase 1: bots-as-contacts)
  // -------------------------------------------------------------------------
  app.get("/api/bots", async () => {
    return { bots: getChat()?.bots.list() ?? [] };
  });

  app.get<{ Querystring: { channelId?: string } }>("/api/threads", async (request, reply) => {
    const chat = getChat();
    if (!chat) return reply.status(503).send({ error: "chat not available" });
    return { threads: await chat.getThreads(request.query.channelId) };
  });

  app.post<{ Body: { title?: string; channelId?: string; botId?: string } }>("/api/threads", async (request, reply) => {
    const chat = getChat();
    if (!chat) return reply.status(503).send({ error: "chat not available" });
    const thread = await chat.createThread(request.body ?? {});
    return reply.status(201).send({ ok: true, thread });
  });

  app.get<{ Params: { id: string }; Querystring: { limit?: string } }>("/api/threads/:id/messages", async (request, reply) => {
    const chat = getChat();
    if (!chat) return reply.status(503).send({ error: "chat not available" });
    const raw = request.query.limit;
    let limit = 100;
    if (raw !== undefined) {
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        limit = parsed;
      }
    }
    try {
      // ChatCore.getMessages does not throw for unknown threads — check explicitly.
      const threads = await chat.getThreads();
      if (!threads.some((t) => t.id === request.params.id)) {
        return reply.status(404).send({ error: "thread not found" });
      }
      const messages = await chat.getMessages(request.params.id, limit);
      return { messages, threadId: request.params.id };
    } catch (err) {
      if (err instanceof Error && err.message === "thread not found") return reply.status(404).send({ error: "thread not found" });
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /api/chat/history — DialogueEngine history
  app.get<{ Querystring: { channelId?: string; limit?: string } }>("/api/chat/history", async (request) => {
    const engine = getDialogueEngine();
    if (!engine) return { messages: [] };
    const limit = request.query.limit ? parseInt(request.query.limit, 10) : 100;
    return { messages: engine.getHistory(request.query.channelId, limit) };
  });

  app.post<{ Body: { threadId?: string; title?: string; message?: string; agentId?: string; botId?: string; content?: string; channelId?: string } }>("/api/chat", async (request, reply) => {
    const body = (request.body ?? {}) as { threadId?: string; title?: string; message?: string; agentId?: string; botId?: string; content?: string; channelId?: string };
    const targetBot = body.botId ?? body.agentId;
    if (body.message && typeof body.message === "string" && body.message.trim() !== "") {
      const chat = getChat();
      if (!chat) {
        const engine = getDialogueEngine();
        if (engine) {
          const targetChannel = body.channelId ?? (targetBot ? `dm-${targetBot}` : "trading-floor");
          const message = await engine.handleUserMessage(body.message, targetChannel);
          return { ok: true, message, fallback: "dialogue-engine" };
        }
        return reply.status(503).send({ error: "chat not available" });
      }
      try {
        let threadId = body.threadId;
        let thread;
        if (!threadId) {
          thread = await chat.createThread({
            title: body.title ?? body.message.slice(0, 60),
            botId: targetBot,
            channelId: body.channelId,
          });
          threadId = thread.id;
        } else {
          const threads = await chat.getThreads();
          thread = threads.find((t) => t.id === threadId);
          if (!thread) return reply.status(404).send({ error: "thread not found" });
        }
        const result = await chat.sendUserMessage(threadId, body.message, {
          agentId: body.agentId,
          botId: targetBot,
        });
        return { ok: true, thread, message: result.message, planId: result.planId ?? null };
      } catch (err) {
        if (err instanceof Error && err.message === "thread not found") {
          return reply.status(404).send({ error: "thread not found" });
        }
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (body.content && typeof body.content === "string" && body.content.trim() !== "") {
      const engine = getDialogueEngine();
      if (!engine) return reply.status(503).send({ error: "dialogue engine not available" });
      const targetChannel = body.channelId ?? (targetBot ? `dm-${targetBot}` : "trading-floor");
      const message = await engine.handleUserMessage(body.content, targetChannel);
      return { ok: true, message };
    }
    return reply.status(400).send({ error: "message (ChatCore) or content (dialogue) is required" });
  });

  // -------------------------------------------------------------------------
  // POST /api/agents/custom — Dynamic agent creator (from main)
  // -------------------------------------------------------------------------
  app.post<{
    Body: {
      id?: string;
      name?: string;
      avatar?: string;
      role?: string;
      color?: string;
      description?: string;
      personaPrompt?: string;
      strategyId?: string;
      symbols?: string[];
      parameters?: Record<string, unknown>;
    };
  }>("/api/agents/custom", async (request, reply) => {
    const runtime = getRuntime();
    const engine = getDialogueEngine();
    if (!runtime || !engine) return reply.status(503).send({ error: "runtime or dialogue engine not available" });
    const body = request.body || {};
    const name = body.name?.trim();
    if (!name) return reply.status(400).send({ error: "Agent name is required" });
    const id = body.id?.trim() || `bot-${name.toLowerCase().replace(/[^a-z0-9]/g, "-")}-${Date.now().toString(36).substring(4)}`;
    const avatar = body.avatar?.trim() || "🤖";
    const role = body.role?.trim() || "Custom Quant Analyst";
    const color = body.color?.trim() || "#10b981";
    const description = body.description?.trim() || `Custom AI agent for ${role}`;
    const personaPrompt = body.personaPrompt?.trim() || "Analyze market movements and provide alpha signals.";
    const customBot = new CustomBotAgent(runtime.getEventBus(), { id, name, avatar, role, color, description, personaPrompt, strategyId: body.strategyId, symbols: body.symbols || ["BTCUSDT", "ETHUSDT"], parameters: body.parameters || {}, enabled: true });
    try {
      runtime.registerAgent(customBot);
      await customBot.start();
      engine.registerAgentProfile({ id, name, avatar, role, color, description });
      engine.postMessage({ channelId: "trading-floor", senderId: id, senderName: name, senderAvatar: avatar, senderRole: role, senderColor: color, content: `👋 Hello team! I am **${name}** (${role}). Ready to analyze markets and collaborate.` });
      return { ok: true, agent: customBot.getProfile() };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/api/orders/pending", async () => {
    const engine = getDialogueEngine();
    if (!engine) return { orders: [] };
    return { orders: engine.getPendingOrders() };
  });

  app.post<{
    Body: { symbol?: string; side?: "buy" | "sell"; quantity?: number; price?: number; type?: "market" | "limit"; strategy?: string; reason?: string };
  }>("/api/orders/propose", async (request, reply) => {
    const engine = getDialogueEngine();
    if (!engine) return reply.status(503).send({ error: "dialogue engine not available" });
    const b = request.body || {};
    if (!b.symbol || !b.side || typeof b.quantity !== "number") return reply.status(400).send({ error: "symbol, side, and quantity are required" });
    const proposal = engine.createProposedOrder({ symbol: b.symbol.toUpperCase(), side: b.side, quantity: b.quantity, price: b.price ?? 0, type: b.type ?? "market", strategy: b.strategy, reason: b.reason });
    return { ok: true, order: proposal };
  });

  app.post<{ Params: { id: string } }>("/api/orders/:id/approve", async (request, reply) => {
    const engine = getDialogueEngine();
    if (!engine) return reply.status(503).send({ error: "dialogue engine not available" });
    const order = engine.approveOrder(request.params.id);
    if (!order) return reply.status(404).send({ error: "order proposal not found" });
    return { ok: true, order };
  });

  app.post<{ Params: { id: string }; Body?: { reason?: string } }>("/api/orders/:id/reject", async (request, reply) => {
    const engine = getDialogueEngine();
    if (!engine) return reply.status(503).send({ error: "dialogue engine not available" });
    const order = engine.rejectOrder(request.params.id, request.body?.reason);
    if (!order) return reply.status(404).send({ error: "order proposal not found" });
    return { ok: true, order };
  });

  // -------------------------------------------------------------------------
  // APPROVALS (Phase 2)
  // -------------------------------------------------------------------------
  app.get<{ Querystring: { status?: string } }>("/api/proposals", async (request, reply) => {
    const approvals = getApprovals();
    if (!approvals) return reply.status(503).send({ error: "approvals not available" });
    return { proposals: await approvals.list(request.query.status as any) };
  });

  app.post<{
    Body: {
      symbol?: string;
      side?: string;
      quantity?: number;
      price?: number;
      confidence?: number;
      reason?: string;
      strategy?: string;
      threadId?: string;
    };
  }>("/api/proposals", async (request, reply) => {
    const approvals = getApprovals();
    if (!approvals) return reply.status(503).send({ error: "approvals not available" });
    const body = request.body ?? {};
    if (
      !body.symbol ||
      typeof body.symbol !== "string" ||
      (body.side !== "buy" && body.side !== "sell") ||
      typeof body.quantity !== "number" ||
      !(body.quantity > 0) ||
      typeof body.price !== "number" ||
      !(body.price > 0)
    ) {
      return reply.status(400).send({ error: "symbol, side (buy|sell), quantity (>0), price (>0) are required" });
    }
    try {
      const proposal = await approvals.propose({
        symbol: body.symbol,
        side: body.side,
        quantity: body.quantity,
        price: body.price,
        confidence: body.confidence,
        reason: body.reason,
        strategy: body.strategy,
        threadId: body.threadId,
      } as any);
      return reply.status(201).send({ ok: true, proposal });
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post<{ Params: { id: string }; Body: { agentId?: string } }>(
    "/api/proposals/:id/approve",
    async (request, reply) => {
      const approvals = getApprovals();
      if (!approvals) return reply.status(503).send({ error: "approvals not available" });
      try {
        const { proposal, result } = await approvals.approve(request.params.id, {
          agentId: request.body?.agentId,
        });
        return { ok: true, proposal, result };
      } catch (err) {
        if (err instanceof ApprovalError) {
          if (err.code === "NOT_FOUND") return reply.status(404).send({ error: err.message });
          if (err.code === "EXPIRED") return reply.status(410).send({ error: err.message });
          if (err.code === "NOT_PENDING") return reply.status(409).send({ error: err.message });
          if (err.code === "NO_PIPELINE") return reply.status(503).send({ error: err.message });
        }
        return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  app.post<{ Params: { id: string }; Body: { reason?: string } }>(
    "/api/proposals/:id/reject",
    async (request, reply) => {
      const approvals = getApprovals();
      if (!approvals) return reply.status(503).send({ error: "approvals not available" });
      try {
        const rejected = (await approvals.reject(request.params.id, request.body?.reason)) as unknown;
        let proposal: unknown =
          (rejected as { proposal?: unknown } | null | undefined)?.proposal ?? rejected;
        if (proposal == null) {
          try {
            proposal = await approvals.get(request.params.id);
          } catch {
            proposal = null;
          }
        }
        return { ok: true, proposal };
      } catch (err) {
        if (err instanceof ApprovalError) {
          if (err.code === "NOT_FOUND") return reply.status(404).send({ error: err.message });
          if (err.code === "EXPIRED") return reply.status(410).send({ error: err.message });
          if (err.code === "NOT_PENDING") return reply.status(409).send({ error: err.message });
          if (err.code === "NO_PIPELINE") return reply.status(503).send({ error: err.message });
        }
        const status = err instanceof ApprovalError ? 409 : 500;
        return reply.status(status).send({ error: err instanceof Error ? err.message : String(err) });
      }
    },
  );

  // -------------------------------------------------------------------------
  // LLM (Phase 4)
  // -------------------------------------------------------------------------
  app.get("/api/llm/models", async (_request, reply) => {
    const chat = getChat();
    if (!chat) return reply.status(503).send({ error: "chat not available" });
    const llm = getLlm();
    const models = chat.bots.list().map((bot) => {
      if (!bot.llm) {
        return {
          botId: bot.id,
          name: bot.name,
          provider: "none",
          model: "deterministic",
          configured: false,
          reason: "deterministic mode (no llm)",
        };
      }
      const cfg = bot.llm as unknown as AnyLlmConfig;
      if (cfg.provider === "cli") {
        const command = typeof cfg.command === "string" ? cfg.command : "";
        const model = cfg.model ?? "agent default";
        if (!llm) {
          return {
            botId: bot.id,
            name: bot.name,
            provider: "cli",
            model,
            command,
            configured: false,
            reason: "llm service unavailable",
          };
        }
        let configured = false;
        try {
          configured = llm.isConfigured(bot.llm);
        } catch {
          configured = false;
        }
        if (command.trim() === "") {
          configured = false;
        }
        return {
          botId: bot.id,
          name: bot.name,
          provider: "cli",
          model,
          command,
          configured,
          reason: configured ? "ok" : (command.trim() === "" ? "missing command" : "cli not configured"),
        };
      }
      if (!llm) {
        return {
          botId: bot.id,
          name: bot.name,
          provider: cfg.provider,
          model: cfg.model,
          configured: false,
          reason: "llm service unavailable",
        };
      }
      let configured = false;
      try {
        configured = llm.isConfigured(bot.llm);
      } catch {
        configured = false;
      }
      return {
        botId: bot.id,
        name: bot.name,
        provider: cfg.provider,
        model: cfg.model,
        configured,
        reason: configured ? "ok" : `missing env ${cfg.apiKeyEnv}`,
      };
    });
    return { models };
  });

  app.get("/api/llm/usage", async () => {
    const llm = getLlm();
    const chat = getChat();
    if (llm) {
      try {
        await llm.usageReady();
      } catch {
        // Best-effort; fall through to whatever is in memory.
      }
    }
    const snapshot = llm?.getUsage() ?? {
      rows: [],
      totals: { turns: 0, tokens: 0, costUsd: null },
    };
    const names = new Map(
      (chat?.bots.list() ?? []).map((bot) => [bot.id, bot.name] as const),
    );
    return {
      usage: snapshot.rows.map((row) => ({
        ...row,
        name: names.get(row.botId) ?? row.botId,
      })),
      totals: snapshot.totals,
    };
  });

  app.get("/api/llm/engines", async () => {
    try {
      const mod = await import("../llm/engines.js") as unknown as {
        getEngineStatuses: (probe?: boolean) => Promise<Array<Record<string, unknown>>>;
      };
      const engines = await mod.getEngineStatuses();
      return { engines };
    } catch {
      return { engines: [] };
    }
  });

  app.post<{
    Params: { id: string };
    Body: { command?: string; name?: string };
  }>("/api/llm/engines/:id/cli", async (request, reply) => {
    const body = request.body ?? {};
    const command = typeof body.command === "string" ? body.command.trim() : "";
    const id = request.params.id.trim();
    if (!command) {
      return reply.status(400).send({ error: "command is required and must be a non-empty string" });
    }
    if (!id) {
      return reply.status(400).send({ error: "engine id is required" });
    }
    try {
      const mod = await import("../llm/engines.js") as unknown as {
        findEngineEntry: (id: string) => Promise<{ id: string } | undefined>;
        saveEngineOverride: (dataDir: string | undefined, id: string, command: string | undefined) => Promise<void>;
        getEngineStatuses: (probe?: boolean) => Promise<Array<{ id: string } & Record<string, unknown>>>;
      };
      const entry = await mod.findEngineEntry(id);
      if (!entry) {
        return reply.status(404).send({ error: `unknown engine id '${id}'` });
      }
      // Known catalog engine — persist a path override.
      await mod.saveEngineOverride(undefined, id, command);
      const statuses = await mod.getEngineStatuses();
      const engine = statuses.find((s) => s.id === id) ?? null;
      return { ok: true, engine };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.delete<{
    Params: { id: string };
  }>("/api/llm/engines/:id/cli", async (request, reply) => {
    try {
      const mod = await import("../llm/engines.js") as unknown as {
        findEngineEntry: (id: string) => Promise<{ id: string } | undefined>;
        saveEngineOverride: (dataDir: string | undefined, id: string, command: string | undefined) => Promise<void>;
        getEngineStatuses: (probe?: boolean) => Promise<Array<{ id: string } & Record<string, unknown>>>;
      };
      const id = request.params.id.trim();
      const entry = await mod.findEngineEntry(id);
      if (!entry) {
        return reply.status(404).send({ error: `unknown engine id '${id}'` });
      }
      await mod.saveEngineOverride(undefined, id, undefined);
      const statuses = await mod.getEngineStatuses();
      const engine = statuses.find((s) => s.id === id) ?? null;
      return { ok: true, engine };
    } catch (err) {
      return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // -------------------------------------------------------------------------
  // Phase 4 — Provider & Engine Layer Routes
  // -------------------------------------------------------------------------
  app.get("/api/llm/providers", async () => {
    const registry = getProviderRegistry();
    const providers = registry.list().map((p) => ({
      id: p.id,
      name: p.name,
      supportsTools: p.supportsTools(),
    }));
    return { providers };
  });

  app.get("/api/llm/providers/health", async () => {
    const registry = getProviderRegistry();
    const health = await registry.getHealth();
    return { health };
  });

  app.get("/api/llm/tools", async () => {
    const toolRegistry = getFinanceToolRegistry();
    return { tools: toolRegistry.getDefinitions() };
  });

  app.get<{ Querystring: { includeArchived?: string } }>("/api/agent-runtime/agents", async (request) => {
    const runtime = getAgentRuntime();
    const includeArchived = request.query?.includeArchived === "true" || request.query?.includeArchived === "1";
    return { agents: runtime.listAgents({ includeArchived }) };
  });

  app.get("/api/agent-runtime/templates", async () => {
    return {
      templates: COWORKER_TEMPLATES.map((t) => ({
        key: t.key,
        name: t.name,
        role: t.role,
        description: t.description,
        engine: t.engine,
        tools: t.tools,
        permissions: t.permissions,
        riskPermissions: t.riskPermissions,
        responsibilities: t.responsibilities,
        constraints: t.constraints,
        systemPrompt: templateSystemPrompt(t),
      })),
    };
  });

  app.get("/api/agent-runtime/providers", async () => {
    const providerRegistry = getProviderRegistry();
    const engineManager = getEngineManager();
    const cliManager = getCliManager();
    const { CliProvider } = await import("../llm/providers/cli-engine.js");
    const engineConfigs = engineManager.listEngineConfigs();
    const providers = [];
    for (const provider of providerRegistry.list()) {
      const isCli = provider instanceof CliProvider;
      // Provider ids follow `cli-<adapterId>`; resolve the backing adapter
      // through the live CLI manager so stale/uninstalled CLIs are visible.
      let adapter: ReturnType<typeof cliManager.get> = undefined;
      if (isCli && provider.id.startsWith("cli-")) {
        adapter = cliManager.get(provider.id.slice(4));
      }
      const meta = adapter?.getMetadata();
      let resolvedPath: string | null = null;
      if (adapter) {
        try {
          resolvedPath = await adapter.resolveExecutable();
        } catch {
          resolvedPath = null;
        }
      }
      const engines = engineConfigs
        .filter(
          (e) =>
            e.config.provider === provider.id ||
            e.id === provider.id ||
            (meta && (e.id === meta.id || e.id === `${meta.id}-cli`)),
        )
        .map((e) => e.id);
      let health: { status: string; message?: string };
      try {
        const h = await provider.healthCheck();
        health = { status: h.status, message: h.message };
      } catch (err) {
        health = { status: "error", message: err instanceof Error ? err.message : String(err) };
      }
      providers.push({
        id: provider.id,
        name: provider.name,
        kind: isCli ? "cli" : "api",
        // No secrets here: metadata, resolution and health carry names/paths only.
        adapter: meta
          ? {
              id: meta.id,
              executable: meta.executable,
              installed: resolvedPath !== null,
              resolvedPath,
              taskDelivery: meta.taskDelivery,
              sessionModes: [...meta.sessionModes ?? []],
              supportsStreaming: meta.supportsStreaming,
              supportsCancellation: meta.supportsCancellation,
              installHint: meta.installHint,
            }
          : null,
        engines,
        health,
      });
    }
    return { providers };
  });

  app.post<{
    Body: { id?: string; name?: string; engine?: string; model?: string; systemPrompt?: string; tools?: string[]; permissions?: any; riskPermissions?: any; description?: string; role?: string; responsibilities?: string[]; constraints?: string[] };
  }>("/api/agent-runtime/agents", async (request, reply) => {
    const body = request.body || {};
    const clean = sanitizeBotInput(body);
    if (!clean.ok) {
      return reply.status(400).send({ error: "invalid coworker config", details: clean.errors });
    }
    const runtime = getAgentRuntime();
    const engineManager = getEngineManager();
    const toolRegistry = getFinanceToolRegistry();
    const result = await validateCoworkerInput(
      body,
      buildCoworkerValidationDeps(runtime, engineManager, toolRegistry),
    );
    if (!result.ok || !result.normalized) {
      const taken = result.errors.some((e) => e.includes("already taken"));
      return reply.status(taken ? 409 : 400).send({ error: "invalid coworker config", details: result.errors });
    }
    runtime.registerAgent(result.normalized);
    return { ok: true, agent: runtime.getAgent(result.normalized.id) };
  });

  app.get<{ Params: { id: string } }>("/api/agent-runtime/agents/:id", async (request, reply) => {
    const runtime = getAgentRuntime();
    const agent = runtime.getAgent(request.params.id);
    if (!agent) return reply.status(404).send({ error: `Agent '${request.params.id}' not found` });
    return { agent };
  });

  app.put<{
    Params: { id: string };
    Body: { id?: string; name?: string; engine?: string; model?: string; systemPrompt?: string; tools?: string[]; permissions?: any; riskPermissions?: any; description?: string; role?: string; responsibilities?: string[]; constraints?: string[] };
  }>("/api/agent-runtime/agents/:id", async (request, reply) => {
    const runtime = getAgentRuntime();
    const id = request.params.id;
    if (!runtime.getAgent(id)) {
      return reply.status(404).send({ error: `Agent '${id}' not found` });
    }
    const body = request.body || {};
    if (typeof body.id === "string" && body.id.trim() && body.id.trim().toLowerCase() !== id.toLowerCase()) {
      return reply.status(400).send({ error: `body id '${body.id}' does not match path id '${id}'` });
    }
    const clean = sanitizeBotInput(body);
    if (!clean.ok) {
      return reply.status(400).send({ error: "invalid coworker config", details: clean.errors });
    }
    const engineManager = getEngineManager();
    const toolRegistry = getFinanceToolRegistry();
    const result = await validateCoworkerInput(
      { ...body, id },
      buildCoworkerValidationDeps(runtime, engineManager, toolRegistry, id),
    );
    if (!result.ok || !result.normalized) {
      return reply.status(400).send({ error: "invalid coworker config", details: result.errors });
    }
    runtime.updateAgent(id, result.normalized);
    return { ok: true, agent: runtime.getAgent(id) };
  });

  app.post<{ Params: { id: string } }>("/api/agent-runtime/agents/:id/archive", async (request, reply) => {
    const runtime = getAgentRuntime();
    const id = request.params.id;
    const agent = runtime.getAgent(id);
    if (!agent) return reply.status(404).send({ error: `Agent '${id}' not found` });
    if (isBuiltInAgent(id)) {
      return reply.status(403).send({ error: `Agent '${id}' is a built-in system agent and cannot be archived` });
    }
    if (agent.archived) {
      return reply.status(409).send({ error: `Agent '${id}' is already archived` });
    }
    return { ok: true, agent: runtime.setArchived(id, true) };
  });

  app.post<{ Params: { id: string } }>("/api/agent-runtime/agents/:id/unarchive", async (request, reply) => {
    const runtime = getAgentRuntime();
    const id = request.params.id;
    const agent = runtime.getAgent(id);
    if (!agent) return reply.status(404).send({ error: `Agent '${id}' not found` });
    if (!agent.archived) {
      return reply.status(409).send({ error: `Agent '${id}' is not archived` });
    }
    return { ok: true, agent: runtime.setArchived(id, false) };
  });

  app.delete<{ Params: { id: string } }>("/api/agent-runtime/agents/:id", async (request, reply) => {
    const runtime = getAgentRuntime();
    if (isBuiltInAgent(request.params.id) && runtime.getAgent(request.params.id)) {
      return reply.status(403).send({ error: `Agent '${request.params.id}' is a built-in system agent and cannot be deleted (archive a custom bot instead)` });
    }
    const deleted = runtime.deleteAgent(request.params.id);
    if (!deleted) return reply.status(404).send({ error: `Agent '${request.params.id}' not found` });
    return { ok: true, id: request.params.id };
  });

  app.get<{ Params: { id: string } }>("/api/agent-runtime/agents/:id/export", async (request, reply) => {
    const runtime = getAgentRuntime();
    const agent = runtime.getAgent(request.params.id);
    if (!agent) return reply.status(404).send({ error: `Agent '${request.params.id}' not found` });
    // Export clean json without sensitive tokens/keys
    const exportData = {
      name: agent.name,
      description: agent.description,
      role: agent.role,
      engine: agent.engine,
      model: agent.model,
      systemPrompt: agent.systemPrompt,
      tools: agent.tools,
      permissions: agent.permissions,
      riskPermissions: agent.riskPermissions,
      exportedAt: new Date().toISOString(),
    };
    return { ok: true, agent: exportData };
  });

  app.post<{ Body: { agentJson: any } }>("/api/agent-runtime/agents/import", async (request, reply) => {
    const body = request.body || {};
    const agentData = body.agentJson;
    if (!agentData || !agentData.name || !agentData.engine) {
      return reply.status(400).send({ error: "Invalid agent JSON. 'name' and 'engine' are required." });
    }
    // Imported ids must not collide with existing agents; always mint a fresh id
    // unless the provided one is both valid and free.
    const runtime = getAgentRuntime();
    const engineManager = getEngineManager();
    const toolRegistry = getFinanceToolRegistry();
    const candidate = {
      ...agentData,
      id: undefined as string | undefined,
    };
    const clean = sanitizeBotInput(candidate);
    if (!clean.ok) {
      return reply.status(400).send({ error: "invalid agent JSON", details: clean.errors });
    }
    const proposedId = typeof agentData.id === "string" ? agentData.id.trim().toLowerCase() : "";
    const idFree = proposedId && runtime.getAgent(proposedId) === undefined;
    if (idFree) candidate.id = proposedId;
    const result = await validateCoworkerInput(
      candidate,
      buildCoworkerValidationDeps(runtime, engineManager, toolRegistry),
    );
    if (!result.ok || !result.normalized) {
      return reply.status(400).send({ error: "invalid agent JSON", details: result.errors });
    }
    const newAgent = { ...result.normalized };
    // Guarantee a fresh unique id on import even if validation derived one.
    if (!idFree || runtime.getAgent(newAgent.id) !== undefined) {
      newAgent.id = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    }
    runtime.registerAgent(newAgent);
    return { ok: true, agent: newAgent };
  });

  app.get("/api/ollama/models", async (_request, reply) => {
    try {
      const providerRegistry = getProviderRegistry();
      const ollamaProvider = providerRegistry.get("ollama");
      if (!ollamaProvider) return { available: false, models: [], message: "Ollama provider not registered" };
      const health = await ollamaProvider.healthCheck();
      if (health.status !== "ok") {
        return { available: false, models: [], message: health.message || "Ollama is unavailable. Start Ollama and try again." };
      }
      const models = await ollamaProvider.listModels();
      return { available: true, models };
    } catch {
      return { available: false, models: [], message: "Ollama is unavailable. Start Ollama and try again." };
    }
  });

  app.post<{
    Body: { agentId?: string; prompt?: string; history?: any[] };
  }>("/api/agent-runtime/chat/stream", async (request, reply) => {
    const body = request.body || {};
    const agentId = body.agentId || "btc-quant-agent";
    const prompt = body.prompt;

    if (!prompt || typeof prompt !== "string") {
      return reply.status(400).send({ error: "prompt is required" });
    }

    const runtime = getAgentRuntime();

    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Access-Control-Allow-Origin": "*",
    });

    try {
      const stream = runtime.runAgentStream(agentId, prompt, body.history || []);
      for await (const event of stream) {
        reply.raw.write(`event: ${event.type}\n`);
        reply.raw.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      const errEvent = {
        type: "error",
        error: err instanceof Error ? err.message : String(err),
        timestamp: Date.now(),
      };
      reply.raw.write(`event: error\n`);
      reply.raw.write(`data: ${JSON.stringify(errEvent)}\n\n`);
    } finally {
      reply.raw.end();
    }
  });

  app.post<{
    Params: { id: string };
    Body: { provider?: string; command?: string; model?: string; args?: string[]; baseUrl?: string; apiKeyEnv?: string; engine?: string };
  }>(
    "/api/bots/:id/engine",
    async (request, reply) => {
      const chat = getChat();
      if (!chat) return reply.status(503).send({ error: "chat not available" });
      const body = request.body ?? {};
      if (body.args !== undefined) {
        if (!Array.isArray(body.args) || !body.args.every((a) => typeof a === "string")) {
          return reply.status(400).send({ error: "args must be a string array" });
        }
      }
      // Engine-catalog path: { engine: "<catalog id>", model?, args?, baseUrl?, apiKeyEnv? }
      const engineId = typeof body.engine === "string" ? body.engine.trim() : "";
      if (engineId) {
        let mod: {
          findEngineEntry: (id: string) => Promise<{ id: string; kind: string; command: string; suggestedArgs?: string[] } | undefined>;
          loadEngineOverrides: (dataDir?: string) => Promise<Record<string, string>>;
          resolveEngineCommand: (entry: { id: string; command: string }, overrides: Record<string, string>) => string;
        };
        try {
          mod = await import("../llm/engines.js") as unknown as typeof mod;
        } catch (err) {
          return reply.status(500).send({ error: err instanceof Error ? err.message : String(err) });
        }
        const entry = await mod.findEngineEntry(engineId);
        if (!entry) {
          return reply.status(404).send({ error: `unknown engine '${engineId}'` });
        }
        let llmCfg: LlmConfig | undefined;
        if (entry.kind === "openai-compat") {
          const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
          const apiKeyEnv = typeof body.apiKeyEnv === "string" ? body.apiKeyEnv.trim() : "";
          const model = typeof body.model === "string" ? body.model.trim() : "";
          if (!baseUrl || !apiKeyEnv || !model) {
            return reply.status(400).send({ error: "openai-compat requires baseUrl, apiKeyEnv, model" });
          }
          llmCfg = { provider: "openai-compat", baseUrl, apiKeyEnv, model } as unknown as LlmConfig;
        } else {
          const overrides = await mod.loadEngineOverrides();
          const effectiveCommand = mod.resolveEngineCommand(entry, overrides);
          if (!effectiveCommand || effectiveCommand.trim() === "") {
            return reply.status(400).send({ error: `engine '${engineId}' has no command configured` });
          }
          const cfg: AnyLlmConfig = { provider: "cli", command: effectiveCommand.trim() };
          if (typeof body.model === "string" && body.model.trim() !== "") {
            cfg.model = body.model.trim();
          }
          if (body.args !== undefined) {
            cfg.args = body.args;
          } else if (entry.suggestedArgs) {
            cfg.args = [...entry.suggestedArgs];
          }
          llmCfg = cfg as unknown as LlmConfig;
        }
        const bot = chat.bots.updateEngine(request.params.id, llmCfg);
        if (!bot) return reply.status(404).send({ error: "bot not found" });
        return { ok: true, bot };
      }
      if (!body.provider) {
        return reply.status(400).send({ error: "provider is required (cli|openai-compat|none)" });
      }
      let llmCfg: LlmConfig | undefined;
      if (body.provider === "none") {
        llmCfg = undefined;
      } else if (body.provider === "cli") {
        const command = typeof body.command === "string" ? body.command.trim() : "";
        if (!command) {
          return reply.status(400).send({ error: "command is required and must be a non-empty string" });
        }
        const cfg: AnyLlmConfig = { provider: "cli", command };
        if (typeof body.model === "string" && body.model.trim() !== "") {
          cfg.model = body.model.trim();
        }
        if (body.args !== undefined) {
          cfg.args = body.args;
        }
        llmCfg = cfg as unknown as LlmConfig;
      } else if (body.provider === "openai-compat") {
        const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
        const apiKeyEnv = typeof body.apiKeyEnv === "string" ? body.apiKeyEnv.trim() : "";
        const model = typeof body.model === "string" ? body.model.trim() : "";
        if (!baseUrl || !apiKeyEnv || !model) {
          return reply.status(400).send({ error: "baseUrl, apiKeyEnv and model are required and must be non-empty strings" });
        }
        llmCfg = { provider: "openai-compat", baseUrl, apiKeyEnv, model } as unknown as LlmConfig;
      } else {
        return reply.status(400).send({ error: "provider must be one of cli|openai-compat|none" });
      }
      const bot = chat.bots.updateEngine(request.params.id, llmCfg);
      if (!bot) return reply.status(404).send({ error: "bot not found" });
      return { ok: true, bot };
    },
  );

  app.post<{ Params: { id: string }; Body: { model?: string } }>(
    "/api/bots/:id/model",
    async (request, reply) => {
      const chat = getChat();
      if (!chat) return reply.status(503).send({ error: "chat not available" });
      const body = request.body ?? {};
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!model) {
        return reply.status(400).send({ error: "model is required and must be a non-empty string" });
      }
      const bot = chat.bots.updateBot(request.params.id, { model });
      if (!bot) return reply.status(404).send({ error: "bot not found" });
      return { ok: true, bot };
    },
  );

  // -------------------------------------------------------------------------
  // AGENT MEMORY (file-persisted, no SQLite — lightweight JSONL)
  // -------------------------------------------------------------------------
  app.get("/api/memory/stats", async () => {
    const mem = getAgentMemory();
    if (!mem) return { persistEnabled: false, entries: 0, traces: 0 };
    return mem.getStats();
  });
  app.get<{ Querystring: { symbol?: string; limit?: string } }>("/api/memory/traces", async (request) => {
    const mem = getAgentMemory();
    if (!mem) return { traces: [] };
    const lim = Math.min(Math.max(parseInt(request.query.limit ?? "50", 10) || 50, 1), 200);
    return { traces: mem.getTraces(request.query.symbol, lim) };
  });
  app.get<{ Querystring: { agentId?: string; category?: string; limit?: string } }>("/api/memory/entries", async (request) => {
    const mem = getAgentMemory();
    if (!mem) return { entries: [] };
    const agentId = (request.query.agentId ?? "supervisor").trim() || "supervisor";
    const cat = (request.query.category as import("../memory/agent-memory.js").MemoryEntry["category"] | undefined) ?? undefined;
    const lim = Math.min(Math.max(parseInt(request.query.limit ?? "50", 10) || 50, 1), 200);
    const entries = cat ? mem.getByCategory(agentId, cat as never) : mem.getByAgent(agentId);
    return { entries: entries.slice(-lim) };
  });
  app.delete("/api/memory", async () => {
    const mem = getAgentMemory();
    if (!mem) return { ok: false };
    mem.clear();
    return { ok: true };
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
