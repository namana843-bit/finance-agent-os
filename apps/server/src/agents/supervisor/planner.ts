// ============================================================================
// Supervisor — Deterministic Planner
// Pure, rule-based task → plan mapping. No LLM, no I/O, fully deterministic.
// Used by SupervisorAgent; also importable standalone for testing.
// ============================================================================

export type TaskKind = "analyze" | "trade" | "portfolio" | "backtest" | "generic";

export interface PlanStep {
  id: string;
  agentId: string;
  toolId?: string;
  description: string;
  input: Record<string, unknown>;
  dependsOn?: string[];
}

export interface Plan {
  id: string;
  task: string;
  symbol: string | null;
  kind: TaskKind;
  steps: PlanStep[];
  createdAt: number;
}

export interface ValidationResult {
  valid: boolean;
  missingAgents: string[];
  missingTools: string[];
  reasons: string[];
}

// ---------------------------------------------------------------------------
// Symbol extraction — deterministic, no network
// ---------------------------------------------------------------------------

const SYMBOL_MAP: Record<string, string> = {
  BTC: "BTCUSDT",
  ETH: "ETHUSDT",
  BNB: "BNBUSDT",
  SOL: "SOLUSDT",
  EURUSD: "EURUSD",
  AAPL: "AAPL",
  SPY: "SPY",
};

const KNOWN_SYMBOLS = new Set([
  "BTCUSDT",
  "ETHUSDT",
  "BNBUSDT",
  "SOLUSDT",
  "BTC",
  "ETH",
  "BNB",
  "SOL",
  "EURUSD",
  "AAPL",
  "SPY",
]);

function normalizeToken(raw: string): string | null {
  const t = raw.trim().toUpperCase().replace(/[/:\-]/g, "");
  if (!t) return null;
  if (KNOWN_SYMBOLS.has(t)) {
    return SYMBOL_MAP[t] ?? t;
  }
  if (/^[A-Z]{2,5}$/.test(t) && SYMBOL_MAP[t]) return SYMBOL_MAP[t]!;
  if (/^[A-Z]{3,10}USDT$/.test(t)) return t;
  return null;
}

export function extractSymbol(task: string): string | null {
  if (!task || typeof task !== "string") return null;
  const tokens = task
    .toUpperCase()
    .split(/[\s,;|]+/)
    .map((s) => s.replace(/^[^\w]+|[^\w]+$/g, ""))
    .filter(Boolean);

  for (const tok of tokens) {
    const norm = normalizeToken(tok);
    if (norm && norm.endsWith("USDT")) return norm;
  }
  for (const tok of tokens) {
    const norm = normalizeToken(tok);
    if (norm) return norm;
  }

  const m = task.toUpperCase().match(/\b([A-Z]{2,6}USDT|[A-Z]{2,5})\b/);
  if (m?.[1]) {
    const norm = normalizeToken(m[1]!);
    if (norm) return norm;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Task classification — deterministic keyword matching
// ---------------------------------------------------------------------------

export function classifyTask(task: string): TaskKind {
  const lower = (task ?? "").toLowerCase();
  if (/\bbacktest\b|\bback test\b|\bbt:/.test(lower)) return "backtest";
  if (/\bportfolio\b|\bbalance\b|\bpositions?\b|\bpnl\b|\bp&l\b|\ballocation\b/.test(lower)) return "portfolio";
  if (/\btrade\b|\bbuy\b|\bsell\b|\border\b|\bexecute\b|\benter\b|\bexit\b/.test(lower)) return "trade";
  if (/\banalyze\b|\banalysis\b|\banalyse\b|\bresearch\b|\binspect\b|\bevaluate\b|\bsignal\b/.test(lower)) return "analyze";
  return "generic";
}

// ---------------------------------------------------------------------------
// Deterministic synthetic prices for indicator tool steps
// Hash symbol to seed so same symbol always yields same series
// ---------------------------------------------------------------------------

function hashSymbol(symbol: string): number {
  let h = 0;
  for (let i = 0; i < symbol.length; i++) h = (h * 31 + symbol.charCodeAt(i)) >>> 0;
  return h;
}

function syntheticPrices(symbol: string, n = 30): number[] {
  const seed = hashSymbol(symbol || "BTCUSDT");
  const base = 50000 + (seed % 20000);
  const prices: number[] = [];
  let p = base;
  for (let i = 0; i < n; i++) {
    const step = ((seed * 9301 + 49297 * (i + 1)) % 233280) / 233280 * 100 - 50;
    p = Math.max(100, p + step);
    prices.push(Math.round(p * 100) / 100);
  }
  return prices;
}

// ---------------------------------------------------------------------------
// Plan builders — each kind maps to a fixed ordered pipeline
// Market -> Research -> Strategy -> Risk -> Final
// ---------------------------------------------------------------------------

let planSeq = 0;

function nextPlanId(symbol: string | null, kind: TaskKind): string {
  planSeq += 1;
  const sym = symbol ?? "UNKNOWN";
  return `plan-${sym}-${kind}-${Date.now()}-${planSeq}`;
}

function step(
  id: string,
  agentId: string,
  description: string,
  input: Record<string, unknown>,
  toolId?: string,
  dependsOn?: string[],
): PlanStep {
  return { id, agentId, description, input, ...(toolId ? { toolId } : {}), ...(dependsOn ? { dependsOn } : {}) };
}

function buildAnalyzeSteps(symbol: string): PlanStep[] {
  const sym = symbol;
  const prices = syntheticPrices(sym, 30);
  return [
    step("market.fetch_price", "market", `Fetch market price for ${sym}`, { symbol: sym }, "get_price"),
    step("market.fetch_ohlcv", "market", `Fetch OHLCV candles for ${sym}`, { symbol: sym, timeframe: "1h", limit: 50 }, "get_ohlcv", ["market.fetch_price"]),
    step("quant.research", "quant", `Compute indicators (SMA/RSI/MACD/Bollinger) for ${sym}`, { indicator: "rsi", prices, period: 14 }, "calculate_indicator", ["market.fetch_ohlcv"]),
    step("strategy.evaluate", "quant", `Evaluate strategy signal for ${sym}`, { symbol: sym, prices }, undefined, ["quant.research"]),
    step("risk.assess", "risk", `Risk assessment for ${sym}`, { symbol: sym, cash: 100000, price: prices[prices.length - 1], riskPercent: 0.01 }, "calculate_position_size", ["strategy.evaluate"]),
    step("portfolio.summarize", "portfolio", "Final summary / portfolio snapshot", {}, "get_portfolio_snapshot", ["risk.assess"]),
  ];
}

function buildTradeSteps(symbol: string): PlanStep[] {
  const sym = symbol;
  const prices = syntheticPrices(sym, 30);
  return [
    step("market.fetch_price", "market", `Fetch market price for ${sym}`, { symbol: sym }, "get_price"),
    step("quant.research", "quant", `Compute indicators for trade ${sym}`, { indicator: "sma", prices, period: 20 }, "calculate_indicator", ["market.fetch_price"]),
    step("risk.assess", "risk", `Risk check before trade ${sym}`, { symbol: sym, cash: 100000, price: prices[prices.length - 1], riskPercent: 0.01 }, "calculate_position_size", ["quant.research"]),
    step("execution.execute", "execution", `Execute order for ${sym}`, { symbol: sym, side: "buy", quantity: 0.01 }, undefined, ["risk.assess"]),
    step("portfolio.summarize", "portfolio", "Post-trade portfolio snapshot", {}, "get_portfolio_snapshot", ["execution.execute"]),
  ];
}

function buildPortfolioSteps(symbol: string | null): PlanStep[] {
  const sym = symbol;
  return [
    step("portfolio.snapshot", "portfolio", "Get portfolio snapshot", {}, "get_portfolio_snapshot"),
    step("portfolio.positions", "portfolio", `Get positions${sym ? ` for ${sym}` : ""}`, sym ? { symbol: sym } : {}, "get_positions", ["portfolio.snapshot"]),
    step("portfolio.balance", "portfolio", "Get balances", {}, "get_balance", ["portfolio.snapshot"]),
    step("risk.assess", "risk", "Risk metrics review", sym ? { symbol: sym } : {}, undefined, ["portfolio.positions"]),
    step("portfolio.summarize", "portfolio", "Final portfolio report", {}, undefined, ["risk.assess"]),
  ];
}

function buildBacktestSteps(symbol: string): PlanStep[] {
  return [
    step("market.fetch_ohlcv", "market", `Fetch OHLCV for backtest ${symbol}`, { symbol, timeframe: "1h", limit: 100 }, "get_ohlcv"),
    step("strategy.backtest", "quant", `Run backtest for ${symbol}`, { symbol, strategyId: "ema-crossover", timeframe: "1h", limit: 100 }, undefined, ["market.fetch_ohlcv"]),
    step("risk.assess", "risk", "Risk assessment of backtest results", { symbol }, undefined, ["strategy.backtest"]),
    step("portfolio.summarize", "portfolio", "Backtest summary report", { symbol }, undefined, ["risk.assess"]),
  ];
}

function buildGenericSteps(symbol: string | null): PlanStep[] {
  const sym = symbol ?? "BTCUSDT";
  const prices = syntheticPrices(sym, 20);
  return [
    step("market.fetch_price", "market", `Fetch market price for ${sym}`, { symbol: sym }, "get_price"),
    step("quant.research", "quant", `Research indicators for ${sym}`, { indicator: "sma", prices, period: 20 }, "calculate_indicator", ["market.fetch_price"]),
    step("portfolio.summarize", "portfolio", "Final summary", {}, "get_portfolio_snapshot", ["quant.research"]),
  ];
}

export function createPlan(task: string): Plan {
  const symbol = extractSymbol(task);
  const kind = classifyTask(task);
  const symForSteps = symbol ?? "BTCUSDT";

  let steps: PlanStep[];
  switch (kind) {
    case "analyze":
      steps = buildAnalyzeSteps(symForSteps);
      break;
    case "trade":
      steps = buildTradeSteps(symForSteps);
      break;
    case "portfolio":
      steps = buildPortfolioSteps(symbol);
      break;
    case "backtest":
      steps = buildBacktestSteps(symForSteps);
      break;
    case "generic":
    default:
      steps = buildGenericSteps(symbol);
      break;
  }

  return {
    id: nextPlanId(symbol, kind),
    task,
    symbol,
    kind,
    steps,
    createdAt: Date.now(),
  };
}

export function stripPlan(plan: Plan): Omit<Plan, "id" | "createdAt"> & { steps: PlanStep[] } {
  return {
    task: plan.task,
    symbol: plan.symbol,
    kind: plan.kind,
    steps: plan.steps.map((s) => ({ ...s })),
  };
}
