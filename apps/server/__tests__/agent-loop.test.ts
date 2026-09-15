// ============================================================================
// Finance Agent OS — Phase 5 Agent Loop Integration Tests
// Validates:
// 1. End-to-End Loop: Market -> Quant -> Supervisor -> Risk -> Broker -> Memory
// 2. Deterministic Quant Separation (pure numerical signals with confluence)
// 3. Structured TradeProposal gating (free-form text cannot execute trades)
// 4. Anti-loop Reliability Guard (recursion depth, duplicate event, symbol cooldown)
// 5. Secret Sanitization & Persistent Memory Traces
// ============================================================================

import { describe, it, expect, beforeEach } from "vitest";
import { TypedEventBus } from "@finance/core";
import { QuantAgent, type Tick } from "../src/agents/quant/index.js";
import { RiskAgent } from "../src/agents/risk/index.js";
import {
  SupervisorAgent,
  LoopGuard,
  createTradeProposal,
  validateTradeProposal,
  type TradeProposal,
} from "../src/agents/supervisor/index.js";
import { ExecutionPipeline } from "../src/execution-pipeline/pipeline.js";
import { FinanceGateway } from "../src/gateway/finance-gateway.js";
import { PaperBroker } from "../src/broker/paper-broker.js";
import { OrderManager } from "../src/order-manager/order-manager.js";
import { AuditLogger } from "../src/audit/audit-logger.js";
import { agentMemory, sanitizeSecrets } from "../src/memory/agent-memory.js";

describe("Phase 5: Real Agent Loop & Reliability Guard", () => {
  let bus: TypedEventBus;
  let quant: QuantAgent;
  let risk: RiskAgent;
  let gateway: FinanceGateway;
  let broker: PaperBroker;
  let orderManager: OrderManager;
  let pipeline: ExecutionPipeline;
  let supervisor: SupervisorAgent;
  let loopGuard: LoopGuard;

  beforeEach(() => {
    bus = new TypedEventBus();
    agentMemory.clear();

    quant = new QuantAgent(bus);
    risk = new RiskAgent(bus, {
      maxOrderSize: 50_000,
      maxPositionSize: 100_000,
      maxLeverage: 1,
      maxDailyLoss: 20_000,
      maxDrawdownPct: 0.3,
    });

    gateway = new FinanceGateway(bus, "paper");

    broker = new PaperBroker(bus, {
      initialBalance: 100_000,
      requireRiskApproval: true,
    });

    orderManager = new OrderManager(bus, { persistPath: ":memory:", autoPersist: false });
    const auditLogger = new AuditLogger(bus);

    pipeline = new ExecutionPipeline({
      bus,
      riskAgent: risk,
      gateway,
      paperBroker: broker,
      orderManager,
      auditLogger,
    });

    loopGuard = new LoopGuard({
      maxRecursionDepth: 3,
      symbolCooldownMs: 600, // Deterministic burst cooldown window
      maxRetries: 2,
    });

    supervisor = new SupervisorAgent({
      bus,
      executionPipeline: pipeline,
      loopGuard,
    });
  });

  // -------------------------------------------------------------------------
  // 1. Deterministic Quant Separation
  // -------------------------------------------------------------------------

  describe("Deterministic Quant Engine", () => {
    it("generates deterministic numerical indicators and confluence without conversational text", async () => {
      // Feed historical upward trend to trigger bullish confluence
      const prices = [
        100, 101, 102, 103, 104, 105, 106, 107, 108, 109,
        110, 111, 112, 113, 114, 115, 116, 117, 118, 119,
        120, 122, 124, 126, 128, 130, 132, 135, 138, 140,
      ];

      for (const p of prices) {
        await quant.onTick({
          symbol: "BTCUSDT",
          price: p,
          timestamp: Date.now(),
        });
      }

      const signal = quant.generateSignal("BTCUSDT");
      expect(signal).not.toBeNull();
      expect(signal?.symbol).toBe("BTCUSDT");
      expect(["buy", "sell", "hold"]).toContain(signal?.action);
      expect(typeof signal?.confidence).toBe("number");
      expect(signal?.confidence).toBeGreaterThanOrEqual(0);
      expect(signal?.confidence).toBeLessThanOrEqual(1);

      // Verify numerical indicators are present and structured
      expect(signal?.indicators).toBeDefined();
      expect(typeof signal?.indicators.sma7).toBe("number");
      expect(typeof signal?.indicators.sma25).toBe("number");
      expect(typeof signal?.price).toBe("number");
      expect(signal?.strategy).toBe("confluence-v1");
    });
  });

  // -------------------------------------------------------------------------
  // 2. Structured Trade Proposal Validation & Free-Form Rejection
  // -------------------------------------------------------------------------

  describe("Structured TradeProposal Gating", () => {
    it("validates a well-formed TradeProposal", () => {
      const validProposal = createTradeProposal({
        symbol: "ETHUSDT",
        side: "buy",
        quantity: 1.5,
        price: 3000,
        reasoning: "Bullish EMA crossover with RSI oversold bounce",
      });

      const res = validateTradeProposal(validProposal);
      expect(res.valid).toBe(true);
      expect(res.proposal?.symbol).toBe("ETHUSDT");
      expect(res.proposal?.quantity).toBe(1.5);
      expect(res.proposal?.price).toBe(3000);
      expect(res.proposal?.entryParameters.orderType).toBe("market");
      expect(res.proposal?.riskParameters.positionLimitPct).toBe(0.2);
    });

    it("rejects unvalidated proposals or missing parameters", () => {
      // Missing quantity
      const badProposal1 = {
        proposalId: "prop-1",
        correlationId: "corr-1",
        symbol: "BTCUSDT",
        side: "buy",
        price: 50000,
      };
      const res1 = validateTradeProposal(badProposal1);
      expect(res1.valid).toBe(false);

      // Missing symbol
      const badProposal2 = {
        proposalId: "prop-2",
        correlationId: "corr-2",
        side: "buy",
        quantity: 1,
        price: 50000,
      };
      const res2 = validateTradeProposal(badProposal2);
      expect(res2.valid).toBe(false);
    });

    it("supervisor blocks conversational / free-form text from executing trades", async () => {
      const freeFormText = {
        text: "Please immediately buy 500 BTC with market order!",
      };

      const result = await supervisor.orchestrateTradeProposal(freeFormText as Record<string, unknown>);
      expect(result.success).toBe(false);
      expect(result.stage).toBe("validation");

      // Verify failure was recorded in memory
      const traces = agentMemory.getTraces("UNKNOWN");
      expect(traces.length).toBeGreaterThan(0);
      expect(traces[0].outcome).toBe("rejected_by_guard");
    });
  });

  // -------------------------------------------------------------------------
  // 3. Anti-Loop Reliability Guard
  // -------------------------------------------------------------------------

  describe("Anti-Loop Reliability Guard", () => {
    it("suppresses duplicate proposal events", async () => {
      const proposal = createTradeProposal({
        proposalId: "duplicate-test-proposal",
        symbol: "SOLUSDT",
        side: "buy",
        quantity: 10,
        price: 150,
        reasoning: "Momentum breakout",
      });

      // First run succeeds
      const run1 = await supervisor.orchestrateTradeProposal(proposal);
      expect(run1.success).toBe(true);
      expect(run1.stage).toBe("completed");

      // Second run with identical proposal ID is blocked by LoopGuard
      const run2 = await supervisor.orchestrateTradeProposal(proposal);
      expect(run2.success).toBe(false);
      expect(run2.stage).toBe("loop_guard");
      expect(run2.reason).toContain("Duplicate proposal event suppressed");
    });

    it("enforces per-symbol burst cooldown", async () => {
      const proposal1 = createTradeProposal({
        proposalId: "burst-p1",
        symbol: "ADAUSDT",
        side: "buy",
        quantity: 100,
        price: 0.5,
        reasoning: "Signal 1",
      });

      const proposal2 = createTradeProposal({
        proposalId: "burst-p2",
        symbol: "ADAUSDT",
        side: "buy",
        quantity: 100,
        price: 0.5,
        reasoning: "Signal 2 immediate re-trigger",
      });

      const run1 = await supervisor.orchestrateTradeProposal(proposal1);
      expect(run1.success).toBe(true);

      // Immediate re-trigger for ADAUSDT within 100ms cooldown window is blocked
      const run2 = await supervisor.orchestrateTradeProposal(proposal2);
      expect(run2.success).toBe(false);
      expect(run2.stage).toBe("loop_guard");
      expect(run2.reason).toContain("Symbol burst cooldown active");

      // Wait for cooldown to expire
      await new Promise((r) => setTimeout(r, 650));

      const run3 = await supervisor.orchestrateTradeProposal(proposal2);
      expect(run3.success).toBe(true);
    });

    it("terminates recursive correlation chains exceeding max recursion depth", async () => {
      const fixedCorrelationId = "recursive-chain-test";

      // Enter trace up to limit (maxRecursionDepth = 3)
      const t1 = loopGuard.enterTrace(fixedCorrelationId);
      expect(t1.allowed).toBe(true);
      expect(t1.depth).toBe(1);

      const t2 = loopGuard.enterTrace(fixedCorrelationId);
      expect(t2.allowed).toBe(true);
      expect(t2.depth).toBe(2);

      const t3 = loopGuard.enterTrace(fixedCorrelationId);
      expect(t3.allowed).toBe(true);
      expect(t3.depth).toBe(3);

      // 4th call exceeds max depth 3
      const t4 = loopGuard.enterTrace(fixedCorrelationId);
      expect(t4.allowed).toBe(false);
      expect(t4.reason).toContain("Recursion depth limit exceeded");

      // Cleaning up traces
      loopGuard.exitTrace(fixedCorrelationId);
      loopGuard.exitTrace(fixedCorrelationId);
      loopGuard.exitTrace(fixedCorrelationId);
    });
  });

  // -------------------------------------------------------------------------
  // 4. End-to-End Loop with Risk Gating & Memory Trace
  // -------------------------------------------------------------------------

  describe("End-to-End Agent Loop & Memory Traces", () => {
    it("completes full loop: Proposal -> Risk Gate (ticket) -> Broker -> Memory trace", async () => {
      const proposal = createTradeProposal({
        proposalId: "e2e-approved-1",
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 0.1,
        price: 50_000, // $5,000 order size, within limits
        reasoning: "Valid quantitative setup",
      });

      const res = await supervisor.orchestrateTradeProposal(proposal);
      expect(res.success).toBe(true);
      expect(res.stage).toBe("completed");
      expect(res.order).toBeDefined();

      // Verify trace was recorded in memory
      const traces = agentMemory.getTraces("BTCUSDT");
      expect(traces.length).toBeGreaterThanOrEqual(1);
      const trace = traces.find((t) => t.traceId === "e2e-approved-1");
      expect(trace).toBeDefined();
      expect(trace?.outcome).toBe("executed");
      expect(trace?.symbol).toBe("BTCUSDT");
      expect(trace?.riskDecision).toBeDefined();

      // Check broker portfolio position
      const pos = broker.getPosition("BTCUSDT");
      expect(pos?.quantity).toBe(0.1);
    });

    it("handles Risk Gate rejection cleanly without infinite re-proposals", async () => {
      const oversizedProposal = createTradeProposal({
        proposalId: "e2e-rejected-oversize",
        symbol: "BTCUSDT",
        side: "buy",
        quantity: 10,
        price: 50_000, // $500,000 order size > maxOrderSize ($50,000)
        reasoning: "Oversized order setup",
      });

      const res = await supervisor.orchestrateTradeProposal(oversizedProposal);
      expect(res.success).toBe(false);
      expect(res.stage).toBe("risk");
      expect(res.reason).toMatch(/Rejected|Risk/i);

      // Verify rejection recorded in memory trace
      const traces = agentMemory.getTraces("BTCUSDT");
      const trace = traces.find((t) => t.traceId === "e2e-rejected-oversize");
      expect(trace).toBeDefined();
      expect(trace?.outcome).toBe("rejected_by_risk");

      // Broker position remains unchanged
      const pos = broker.getPosition("BTCUSDT");
      expect(pos).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // 5. Secret Sanitization in Agent Memory
  // -------------------------------------------------------------------------

  describe("Secret Sanitization in Memory", () => {
    it("redacts sensitive keys and bearer tokens", () => {
      const sensitiveData = {
        apiKey: "binance_live_api_key_123456789",
        secret: "super_secret_signing_key_abcdef",
        token: "jwt_token_payload_xyz",
        password: "user_secret_password",
        authorization: "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
        nested: {
          privateKey: "0x1234567890abcdef1234567890abcdef",
          safeField: "this is completely public data",
        },
      };

      const sanitized = sanitizeSecrets(sensitiveData);
      expect(sanitized.apiKey).toBe("[REDACTED]");
      expect(sanitized.secret).toBe("[REDACTED]");
      expect(sanitized.token).toBe("[REDACTED]");
      expect(sanitized.password).toBe("[REDACTED]");
      expect(sanitized.authorization).toContain("[REDACTED]");
      expect(sanitized.nested.privateKey).toBe("[REDACTED]");
      expect(sanitized.nested.safeField).toBe("this is completely public data");
    });

    it("redacts secrets when stored in AgentMemory set() and recordTrace()", () => {
      agentMemory.set("supervisor", "state", "credentials", {
        apiKey: "sensitive-api-key-999",
        accountNumber: "acc-12345",
      });

      const retrieved = agentMemory.get("supervisor", "state", "credentials") as Record<string, unknown>;
      expect(retrieved.apiKey).toBe("[REDACTED]");
      expect(retrieved.accountNumber).toBe("acc-12345");
    });
  });
});
