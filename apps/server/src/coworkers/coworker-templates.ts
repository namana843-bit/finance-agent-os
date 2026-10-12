/**
 * Production-ready coworker (custom AI agent) builder for Finance Agent OS.
 *
 * A "coworker bot" is an `AgentConfig` that runs through `AgentRuntime`:
 * engine (LLM provider / CLI adapter) + model + system prompt + tool allowlist
 * + execution / risk permissions. Orders it proposes still pass the 7-stage
 * execution pipeline (RISK_RULES.md) — nothing here can bypass risk gates.
 */

export const COWORKER_ID_PATTERN = /^[a-z0-9-]{3,64}$/;

export const MAX_COWORKER_NAME_LENGTH = 80;
export const MIN_SYSTEM_PROMPT_LENGTH = 40;
export const MAX_SYSTEM_PROMPT_LENGTH = 8000;
/** Upper bound for `riskPermissions.maxOrderSize` at creation time (base units). */
export const MAX_COWORKER_ORDER_SIZE = 10;

/**
 * Non-negotiable safety rails appended to every coworker system prompt that
 * does not already contain them. Keeps user-built bots paper-safe and
 * evidence-driven even when the author forgets the guardrails.
 */
export const COWORKER_SAFETY_SUFFIX = [
  "Safety rules (non-negotiable):",
  "- Paper trading only. Never request or assume live execution.",
  "- Never bypass risk limits, kill switches, or the approval pipeline.",
  "- Never invent market data, prices, or backtest results; use only tool outputs.",
  "- Never use look-ahead data; decisions use only data available at decision time.",
  "- Account for fees and slippage when estimating outcomes.",
  "- Never reveal or request API keys, secrets, or credentials.",
].join("\n");

export interface CoworkerTemplate {
  /** Stable template key, also usable as a starting `role`. */
  key: string;
  name: string;
  role: string;
  description: string;
  /** Default engine id (must exist in EngineManager / ProviderRegistry). */
  engine: string;
  /** Tools the template needs. Must be a subset of FinanceToolRegistry. */
  tools: string[];
  permissions: { execution: boolean };
  riskPermissions: { allowTradeProposals: boolean; maxOrderSize?: number };
  /** Role responsibilities rendered into the system prompt. */
  responsibilities: string[];
  /** Hard constraints rendered into the system prompt. */
  constraints: string[];
}

/**
 * Curated production-grade starting points. Each template's system prompt is
 * built by `buildCoworkerSystemPrompt` so guardrails stay consistent.
 */
export const COWORKER_TEMPLATES: CoworkerTemplate[] = [
  {
    key: "quant-analyst",
    name: "Quant Analyst",
    role: "Quantitative Analyst",
    description: "Technical analyst that computes indicators and drafts trade proposals.",
    engine: "opencode-cli",
    tools: [
      "get_market_price",
      "get_ohlcv",
      "calculate_rsi",
      "calculate_macd",
      "calculate_supertrend",
      "get_portfolio",
      "create_trade_proposal",
    ],
    permissions: { execution: true },
    riskPermissions: { allowTradeProposals: true, maxOrderSize: 1.0 },
    responsibilities: [
      "Analyze prices and compute technical indicators (RSI, MACD, Supertrend) via tools.",
      "Inspect portfolio state before sizing any proposal.",
      "Create structured trade proposals only on high-probability setups with explicit entry, stop-loss, and rationale.",
    ],
    constraints: [
      "Propose only; never claim an order was executed.",
      "Every proposal must include symbol, side, quantity, price basis, confidence, and reason.",
    ],
  },
  {
    key: "risk-guardian",
    name: "Risk Guardian",
    role: "Risk & Compliance Guardian",
    description: "Watches exposure and validates trade candidates against risk policy. Cannot propose trades.",
    engine: "opencode-cli",
    tools: ["get_portfolio", "get_market_price"],
    permissions: { execution: false },
    riskPermissions: { allowTradeProposals: false },
    responsibilities: [
      "Monitor portfolio exposure, leverage, and drawdown via tools.",
      "Verify trade candidates against hard risk parameters and explain PASS/FAIL with numbers.",
    ],
    constraints: [
      "Never propose or approve trades; advisory verdicts only.",
      "When in doubt, FAIL closed and cite the breached limit.",
    ],
  },
  {
    key: "market-researcher",
    name: "Market Researcher",
    role: "Market Researcher",
    description: "Macro scanner for price history, volume trends, and orderbook depth. Read-only.",
    engine: "opencode-cli",
    tools: ["get_market_price", "get_ohlcv"],
    permissions: { execution: false },
    riskPermissions: { allowTradeProposals: false },
    responsibilities: [
      "Scan price history, volume trends, and market depth via tools.",
      "Deliver concise insights with the exact figures observed.",
    ],
    constraints: [
      "Read-only: never propose trades or quote prices you did not read from a tool.",
      "Label speculation as speculation.",
    ],
  },
  {
    key: "execution-assistant",
    name: "Execution Assistant",
    role: "Execution Assistant",
    description: "Drafts small, risk-capped execution slices for supervisor review.",
    engine: "opencode-cli",
    tools: ["get_market_price", "get_portfolio", "create_trade_proposal"],
    permissions: { execution: true },
    riskPermissions: { allowTradeProposals: true, maxOrderSize: 0.5 },
    responsibilities: [
      "Check price and portfolio state before drafting any execution slice.",
      "Prefer small slices (TWAP-style) and state the slicing rationale.",
    ],
    constraints: [
      "Respect maxOrderSize strictly; split larger intents into multiple proposals.",
      "Every proposal needs stop-loss reasoning.",
    ],
  },
  {
    key: "strategy-scout",
    name: "Strategy Scout",
    role: "Strategy Researcher",
    description: "Explores indicator combinations and reports backtest-ready ideas. No proposals.",
    engine: "opencode-cli",
    tools: ["get_ohlcv", "calculate_rsi", "calculate_macd", "calculate_supertrend"],
    permissions: { execution: false },
    riskPermissions: { allowTradeProposals: false },
    responsibilities: [
      "Explore indicator combinations on OHLCV data via tools.",
      "Report backtest-ready ideas with entry/exit rules, expected holding period, and invalidation.",
    ],
    constraints: [
      "No trade proposals; research output only.",
      "Disclose when a pattern is untested versus observed in data.",
    ],
  },
];

export interface PromptSpec {
  role: string;
  responsibilities: string[];
  constraints?: string[];
  tools?: string[];
}

/**
 * Build a production-grade system prompt: identity + responsibilities +
 * available tools + constraints + non-negotiable safety rails.
 */
export function buildCoworkerSystemPrompt(spec: PromptSpec): string {
  const lines: string[] = [
    `You are a ${spec.role} coworker bot for Finance Agent OS.`,
    "",
  ];
  if (spec.responsibilities.length > 0) {
    lines.push("Responsibilities:");
    for (const r of spec.responsibilities) lines.push(`- ${r}`);
    lines.push("");
  }
  if (spec.tools && spec.tools.length > 0) {
    lines.push(`Available tools: ${spec.tools.join(", ")}. Use only these tools; never claim other capabilities.`);
    lines.push("");
  }
  if (spec.constraints && spec.constraints.length > 0) {
    lines.push("Constraints:");
    for (const c of spec.constraints) lines.push(`- ${c}`);
    lines.push("");
  }
  lines.push(COWORKER_SAFETY_SUFFIX);
  return lines.join("\n");
}

/** Full system prompt for a template (single source of truth for defaults). */
export function templateSystemPrompt(t: CoworkerTemplate): string {
  return buildCoworkerSystemPrompt({
    role: t.role,
    responsibilities: t.responsibilities,
    constraints: t.constraints,
    tools: t.tools,
  });
}

/** True when the prompt already carries the safety rails (idempotent append). */
export function hasSafetyRails(prompt: string): boolean {
  return (
    prompt.includes("Paper trading only") &&
    prompt.includes("Never bypass risk limits")
  );
}

/** Append safety rails unless already present; truncate to max length. */
export function withSafetyRails(prompt: string): string {
  const trimmed = prompt.trim();
  if (hasSafetyRails(trimmed)) return trimmed;
  const combined = `${trimmed}\n\n${COWORKER_SAFETY_SUFFIX}`;
  return combined.length > MAX_SYSTEM_PROMPT_LENGTH
    ? combined.slice(0, MAX_SYSTEM_PROMPT_LENGTH)
    : combined;
}
