/**
 * Provider routing for coworker runs.
 *
 * A run resolves to an ordered chain: the coworker's configured provider and
 * model first, then any configured fallbacks, then the workspace default for
 * the primary connection. The chain is executed by `streamWithFallback`, which
 * only leaves a provider when that provider failed *before* producing content.
 * Once a token (or tool call) is emitted the response is committed, so a
 * mid-stream failure surfaces as an error instead of a spliced answer.
 */
import type { ChatRequest, LLMEvent } from "@finance/shared";
import type { LLMProvider } from "./provider.js";
import type { EngineManager } from "./registry.js";
import { getProviderConnections } from "./connections.js";

export interface RouteTarget {
  providerId: string;
  model?: string;
}

export interface RoutePlan {
  primary: RouteTarget;
  fallbacks: RouteTarget[];
  /** Cancellation ceiling taken from the primary connection's config. */
  timeoutMs?: number;
  reason?: string;
}

export interface RoutingConfig {
  engine: string;
  model?: string;
  providerId?: string;
  fallbacks?: Array<{ providerId: string; model?: string }>;
}

const DEFAULT_ATTEMPT_TIMEOUT_MS = 180_000;

/** Resolve the coworker's provider chain without touching the network. */
export async function buildRoutePlan(
  config: RoutingConfig,
  engineManager: EngineManager,
): Promise<RoutePlan> {
  const store = getProviderConnections();

  // An explicit providerId wins over the engine alias, so a coworker can point
  // at a second connection of the same vendor (e.g. `openai-work`).
  if (config.providerId) {
    const connection = store.get(config.providerId);
    return {
      primary: { providerId: config.providerId, model: config.model ?? connection?.defaultModel },
      fallbacks: (config.fallbacks ?? connection?.fallbackModels ?? []).map((f) => ({
        providerId: f.providerId,
        model: f.model,
      })),
      timeoutMs: connection?.timeoutMs,
    };
  }

  const { provider, model } = await engineManager.getProviderForEngine(config.engine);
  const connection = store.get(provider.id);
  const explicit = config.fallbacks?.length ? config.fallbacks : connection?.fallbackModels ?? [];

  return {
    primary: { providerId: provider.id, model: config.model ?? model ?? connection?.defaultModel },
    fallbacks: explicit.map((f) => ({ providerId: f.providerId, model: f.model })),
    timeoutMs: connection?.timeoutMs,
  };
}

export interface Attempt {
  provider: LLMProvider;
  providerId: string;
  model?: string;
}

/**
 * Resolve every target in a plan to a live provider instance. Unresolvable
 * targets (removed connection, uninstalled CLI) are reported instead of
 * throwing, so one bad fallback cannot abort the whole run.
 */
export async function resolveAttempts(
  plan: RoutePlan,
  engineManager: EngineManager,
): Promise<{ attempts: Attempt[]; errors: Array<{ providerId: string; error: string }> }> {
  const store = getProviderConnections();
  const attempts: Attempt[] = [];
  const errors: Array<{ providerId: string; error: string }> = [];
  const seen = new Set<string>();

  for (const target of [plan.primary, ...plan.fallbacks]) {
    try {
      const resolved = await engineManager.getProviderForEngine(target.providerId);
      const model = target.model ?? resolved.model ?? store.get(target.providerId)?.defaultModel;
      const key = `${resolved.provider.id}:${model ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      attempts.push({ provider: resolved.provider, providerId: resolved.provider.id, model });
    } catch (err) {
      errors.push({
        providerId: target.providerId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { attempts, errors };
}

export interface StreamWithFallbackOptions {
  signal?: AbortSignal;
  botId?: string;
  timeoutMs?: number;
  /** Builds the provider request for a given model and provider. */
  request: (model: string | undefined, provider: LLMProvider) => ChatRequest;
  onAttemptError?: (providerId: string, error: string) => void;
}

function mergeSignals(timeoutMs: number, external?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!external) return timeout;
  if (typeof AbortSignal.any === "function") return AbortSignal.any([external, timeout]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  external.addEventListener("abort", abort, { once: true });
  timeout.addEventListener("abort", abort, { once: true });
  return controller.signal;
}

/**
 * Stream from the first provider that produces content. Falls back only when
 * an attempt fails before any content is emitted.
 */
export async function* streamWithFallback(
  attempts: Attempt[],
  opts: StreamWithFallbackOptions,
): AsyncIterable<LLMEvent> {
  if (attempts.length === 0) {
    yield {
      type: "error",
      error: "No provider available for this coworker",
      timestamp: Date.now(),
    };
    return;
  }

  let lastError = "No provider produced a response";
  const timeoutMs = opts.timeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS;

  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index]!;
    if (opts.signal?.aborted) return;

    const pending: LLMEvent[] = [];
    let committed = false;
    let attemptError: string | null = null;

    try {
      const stream = attempt.provider.chat(opts.request(attempt.model, attempt.provider), {
        signal: mergeSignals(timeoutMs, opts.signal),
        botId: opts.botId,
      });

      for await (const event of stream) {
        if (opts.signal?.aborted) return;

        if (event.type === "error" && !committed) {
          attemptError = event.error;
          break;
        }

        if (
          !committed &&
          (event.type === "text_delta" ||
            event.type === "reasoning_delta" ||
            event.type === "tool_call" ||
            event.type === "message_complete")
        ) {
          committed = true;
          for (const buffered of pending) yield buffered;
          pending.length = 0;
        }

        if (committed) yield event;
        else pending.push(event);
      }
    } catch (err) {
      if (committed) throw err;
      attemptError = err instanceof Error ? err.message : String(err);
    }

    if (!attemptError) {
      // Completed without an error: flush whatever is still buffered.
      for (const buffered of pending) yield buffered;
      return;
    }

    lastError = attemptError;
    opts.onAttemptError?.(attempt.providerId, attemptError);

    if (index === attempts.length - 1) {
      yield { type: "error", error: lastError, timestamp: Date.now() };
      return;
    }
  }
}
