/**
 * Secret redaction for provider diagnostics.
 *
 * Provider connections reference API keys through environment variable names
 * only, so no code path should ever hold a raw key next to a serialisable
 * object. This module is defence in depth: every provider payload that leaves
 * the server (errors, health messages, model metadata, connection summaries)
 * goes through `redactSecrets`, so an accidental key echo in a provider error
 * body cannot reach the desktop UI, logs or an agent prompt.
 */

const SECRET_KEY_PATTERN = /^(api[_-]?key|apikey|secret|token|password|credential|authorization)/i;

/** Well-known key shapes, redacted wherever they appear inside free text. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-ant-[A-Za-z0-9_-]{8,}\b/g,
  /\bsk-or-v1-[A-Za-z0-9_-]{8,}\b/g,
  /\bxai-[A-Za-z0-9_-]{8,}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}\b/g,
  /\bBearer\s+[A-Za-z0-9._-]{8,}\b/gi,
  /\bgh[pousr]_[A-Za-z0-9]{8,}\b/g,
];

export const REDACTED = "[REDACTED]";

/** Redact key-shaped substrings inside a plain string. */
export function redactText(value: string): string {
  let output = value;
  for (const pattern of SECRET_VALUE_PATTERNS) {
    output = output.replace(pattern, REDACTED);
  }
  // `?key=` / `&api_key=` query parameters (Gemini-style) must never survive.
  output = output.replace(/([?&](?:key|api[_-]?key|token)=)[^&\s"']+/gi, `$1${REDACTED}`);
  return output;
}

/** Deep-redact a JSON-like value. Keys matching the secret pattern are blanked. */
export function redactSecrets<T>(value: T, depth = 0): T {
  if (depth > 6) return REDACTED as unknown as T;
  if (typeof value === "string") return redactText(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((item) => redactSecrets(item, depth + 1)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SECRET_KEY_PATTERN.test(key) ? REDACTED : redactSecrets(entry, depth + 1);
    }
    return out as unknown as T;
  }
  return value;
}

/** True when a value still contains something that looks like a live key. */
export function containsSecret(value: unknown): boolean {
  if (typeof value === "string") {
    return SECRET_VALUE_PATTERNS.some((pattern) => new RegExp(pattern.source, pattern.flags).test(value));
  }
  if (Array.isArray(value)) return value.some(containsSecret);
  if (value && typeof value === "object") {
    return Object.entries(value as Record<string, unknown>).some(
      ([key, entry]) => SECRET_KEY_PATTERN.test(key) || containsSecret(entry),
    );
  }
  return false;
}
