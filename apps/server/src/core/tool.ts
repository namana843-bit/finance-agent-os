import type { EventBus } from "./eventBus.js";

// ---------------------------------------------------------------------------
// Tool system — clean agent/tool interface, finance-specific
// Inspired by OpenMausBot tool calling, scoped to non-trading utilities.
// No trading strategies or live-trading tools live here.
// ---------------------------------------------------------------------------

export interface ToolContext {
  agentId?: string;
  runId?: string;
  bus?: EventBus;
  metadata?: Record<string, unknown>;
}

export interface JsonSchema {
  type?: string;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  items?: JsonSchema;
  enum?: unknown[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  description?: string;
  default?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  requiresApproval?: boolean;
  version?: string;
}

export interface Tool<TInput = unknown, TOutput = unknown> extends ToolDefinition {
  execute(input: TInput, ctx?: ToolContext): TOutput | Promise<TOutput>;
}

export abstract class BaseTool<TInput = unknown, TOutput = unknown> implements Tool<TInput, TOutput> {
  abstract name: string;
  abstract description: string;
  inputSchema?: JsonSchema;
  outputSchema?: JsonSchema;
  requiresApproval?: boolean;
  version?: string;

  abstract execute(input: TInput, ctx?: ToolContext): TOutput | Promise<TOutput>;

  protected validate(input: TInput): void {
    if (this.inputSchema) {
      validateAgainstSchema(input, this.inputSchema, "input");
    }
  }
}

/** Minimal JSON-schema validator (object/string/number/boolean/array/enum/required). Zero deps. */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, path = "value"): void {
  if (!schema || typeof schema !== "object") return;
  if (schema.enum !== undefined) {
    const ok = schema.enum.some((e) => deepEqual(e, value));
    if (!ok) throw new Error(`${path} must be one of ${JSON.stringify(schema.enum)}`);
  }
  if (schema.type) {
    const t = schema.type;
    if (t === "object") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        throw new Error(`${path} must be an object`);
      }
      const record = value as Record<string, unknown>;
      for (const req of schema.required ?? []) {
        if (record[req] === undefined) throw new Error(`${path}.${req} is required`);
      }
      if (schema.properties) {
        for (const [key, sub] of Object.entries(schema.properties)) {
          if (record[key] !== undefined) validateAgainstSchema(record[key], sub, `${path}.${key}`);
        }
      }
      return;
    }
    if (t === "array") {
      if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
      if (schema.items) {
        (value as unknown[]).forEach((item, i) => validateAgainstSchema(item, schema.items!, `${path}[${i}]`));
      }
      return;
    }
    if (t === "string") {
      if (typeof value !== "string") throw new Error(`${path} must be a string`);
      if (schema.minLength !== undefined && value.length < schema.minLength) {
        throw new Error(`${path} must have length >= ${schema.minLength}`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        throw new Error(`${path} must have length <= ${schema.maxLength}`);
      }
      return;
    }
    if (t === "number" || t === "integer") {
      if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${path} must be a number`);
      if (t === "integer" && !Number.isInteger(value)) throw new Error(`${path} must be an integer`);
      if (schema.minimum !== undefined && value < schema.minimum) {
        throw new Error(`${path} must be >= ${schema.minimum}`);
      }
      if (schema.maximum !== undefined && value > schema.maximum) {
        throw new Error(`${path} must be <= ${schema.maximum}`);
      }
      return;
    }
    if (t === "boolean") {
      if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
      return;
    }
  }
  // no type constraint — still recurse into properties if object
  if (schema.properties && typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    for (const req of schema.required ?? []) {
      if (record[req] === undefined) throw new Error(`${path}.${req} is required`);
    }
    for (const [key, sub] of Object.entries(schema.properties)) {
      if (record[key] !== undefined) validateAgainstSchema(record[key], sub, `${path}.${key}`);
    }
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export default BaseTool;
