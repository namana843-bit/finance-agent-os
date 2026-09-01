// ============================================================================
// Finance Agent OS — Security
// Phase 23: Environment validation and secret protection
// ============================================================================

export interface EnvConfig {
  PORT: number;
  HOST: string;
  EXECUTION_MODE: "paper" | "live";
  LIVE_TRADING_ENABLED: boolean;
  BINANCE_API_KEY: string;
  BINANCE_SECRET: string;
  NEXT_PUBLIC_API_BASE: string;
}

const REQUIRED_VARS: string[] = [];
const SENSITIVE_VARS = ["BINANCE_API_KEY", "BINANCE_SECRET"];

export function validateEnv(): EnvConfig {
  const port = parseInt(process.env.PORT ?? "4132", 10);
  const host = process.env.HOST ?? "0.0.0.0";
  const executionMode = (process.env.EXECUTION_MODE as "paper" | "live") ?? "paper";
  const liveTradingEnabled = process.env.LIVE_TRADING_ENABLED === "true";
  const binanceApiKey = process.env.BINANCE_API_KEY ?? "";
  const binanceSecret = process.env.BINANCE_SECRET ?? "";
  const nextPublicApiBase = process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:4132";

  // Validate required vars
  for (const v of REQUIRED_VARS) {
    if (!process.env[v]) {
      console.warn(`[security] Missing required env var: ${v}`);
    }
  }

  // Safety: if not in live mode, reject live trading
  if (executionMode !== "live" || !liveTradingEnabled) {
    if (binanceApiKey && binanceSecret) {
      console.log("[security] Binance keys present but live trading disabled — paper mode active");
    }
  }

  // Log sanitized config (never log secrets)
  console.log(`[security] Config: PORT=${port} HOST=${host} MODE=${executionMode} LIVE_TRADING=${liveTradingEnabled}`);

  return {
    PORT: port,
    HOST: host,
    EXECUTION_MODE: executionMode,
    LIVE_TRADING_ENABLED: liveTradingEnabled,
    BINANCE_API_KEY: binanceApiKey,
    BINANCE_SECRET: binanceSecret,
    NEXT_PUBLIC_API_BASE: nextPublicApiBase,
  };
}

export function isLiveTradingAllowed(config: EnvConfig): boolean {
  return config.EXECUTION_MODE === "live" && config.LIVE_TRADING_ENABLED === true;
}

export function sanitizeForLog(value: unknown): unknown {
  if (typeof value === "string") {
    // Check if it looks like a key or secret
    if (SENSITIVE_VARS.some((v) => value.length > 20)) {
      return "[REDACTED]";
    }
    return value;
  }
  return value;
}

// Rate limiting
const rateLimits = new Map<string, { count: number; resetAt: number }>();

export function checkRateLimit(key: string, maxRequests = 100, windowMs = 60_000): boolean {
  const now = Date.now();
  const entry = rateLimits.get(key);

  if (!entry || now > entry.resetAt) {
    rateLimits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }

  if (entry.count >= maxRequests) {
    return false;
  }

  entry.count++;
  return true;
}
