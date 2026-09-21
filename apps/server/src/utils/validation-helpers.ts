export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value === "object" && value !== null) return value as Record<string, unknown>;
  return {};
}
export function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}
export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
export function asNumberString(value: unknown, fallback: string): string {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : fallback;
}
export function asSide(value: unknown): "buy" | "sell" | null {
  return value === "buy" || value === "sell" ? value : null;
}
export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}
