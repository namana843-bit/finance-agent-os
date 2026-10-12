import {
  COWORKER_ID_PATTERN,
  MAX_COWORKER_NAME_LENGTH,
  MAX_COWORKER_ORDER_SIZE,
  MAX_SYSTEM_PROMPT_LENGTH,
  MIN_SYSTEM_PROMPT_LENGTH,
  withSafetyRails,
} from "./coworker-templates.js";

export interface CoworkerInput {
  id?: string;
  name?: string;
  description?: string;
  role?: string;
  engine?: string;
  model?: string;
  systemPrompt?: string;
  tools?: string[];
  permissions?: { execution?: boolean };
  riskPermissions?: { allowTradeProposals?: boolean; maxOrderSize?: number };
  /** When set, build the system prompt from these instead of `systemPrompt`. */
  responsibilities?: string[];
  constraints?: string[];
}

export interface NormalizedCoworker {
  id: string;
  name: string;
  description?: string;
  role?: string;
  engine: string;
  model?: string;
  systemPrompt: string;
  tools?: string[];
  permissions?: { execution?: boolean };
  riskPermissions?: { allowTradeProposals?: boolean; maxOrderSize?: number };
}

export interface CoworkerValidationDeps {
  /** Returns true when the engine id can serve a coworker. */
  engineExists: (engineId: string) => Promise<boolean> | boolean;
  /** Tool names the runtime can execute. */
  validTools: string[];
  /** Returns true when the id is already taken. */
  idTaken?: (id: string) => Promise<boolean> | boolean;
}

export interface CoworkerValidationResult {
  ok: boolean;
  errors: string[];
  normalized?: NormalizedCoworker;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function cleanString(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return undefined;
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * Validate raw user input for a new coworker bot and normalize it into a
 * runtime-ready config. Pure format checks run first; engine/tool/id
 * existence checks run against the provided deps.
 */
export async function validateCoworkerInput(
  raw: unknown,
  deps: CoworkerValidationDeps,
): Promise<CoworkerValidationResult> {
  const errors: string[] = [];
  if (!isRecord(raw)) return { ok: false, errors: ["body must be a JSON object"] };
  const input = raw as CoworkerInput;

  const name = cleanString(input.name, MAX_COWORKER_NAME_LENGTH);
  if (!name) errors.push("'name' is required (2-80 chars)");

  const engineDirty = typeof input.engine === "string" ? input.engine.trim() : "";
  if (!engineDirty) {
    errors.push("'engine' is required (pick a registered engine id)");
  }

  let id = typeof input.id === "string" ? input.id.trim().toLowerCase() : "";
  if (!id && name) {
    id = `coworker-${name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "bot"}`;
  }
  if (!id) {
    errors.push("'id' is required (or derivable from name): 3-64 chars, lowercase letters, digits, hyphens");
  } else if (!COWORKER_ID_PATTERN.test(id)) {
    errors.push(`'id' '${id}' is invalid: 3-64 chars, lowercase letters, digits, hyphens only`);
  }

  // Tools: must be a subset of the registry; deduped, order preserved.
  let tools: string[] | undefined;
  if (input.tools !== undefined) {
    if (!Array.isArray(input.tools)) {
      errors.push("'tools' must be an array of registered tool names");
    } else {
      const seen = new Set<string>();
      const cleaned: string[] = [];
      const unknown: string[] = [];
      for (const t of input.tools) {
        if (typeof t !== "string" || !t.trim()) continue;
        const n = t.trim();
        if (seen.has(n)) continue;
        seen.add(n);
        if (!deps.validTools.includes(n)) unknown.push(n);
        else cleaned.push(n);
      }
      if (unknown.length > 0) {
        errors.push(`unknown tools: ${unknown.join(", ")} (available: ${deps.validTools.join(", ")})`);
      }
      tools = cleaned;
    }
  }

  // System prompt: explicit text or built from responsibilities.
  let systemPrompt = typeof input.systemPrompt === "string" ? input.systemPrompt.trim() : "";
  if (!systemPrompt && input.responsibilities && input.responsibilities.length > 0) {
    const { buildCoworkerSystemPrompt } = await import("./coworker-templates.js");
    systemPrompt = buildCoworkerSystemPrompt({
      role: (typeof input.role === "string" && input.role.trim()) || "Finance Coworker",
      responsibilities: input.responsibilities.filter((r) => typeof r === "string" && r.trim()),
      constraints: Array.isArray(input.constraints)
        ? input.constraints.filter((c) => typeof c === "string" && c.trim())
        : undefined,
      tools,
    });
  }
  if (!systemPrompt) {
    errors.push(`'systemPrompt' (or 'responsibilities') is required (min ${MIN_SYSTEM_PROMPT_LENGTH} chars) — it defines what the bot does`);
  } else if (systemPrompt.length < MIN_SYSTEM_PROMPT_LENGTH) {
    errors.push(`'systemPrompt' is too short (${systemPrompt.length} chars, min ${MIN_SYSTEM_PROMPT_LENGTH}) — describe the bot's job, inputs, and outputs`);
  } else if (systemPrompt.length > MAX_SYSTEM_PROMPT_LENGTH) {
    errors.push(`'systemPrompt' is too long (${systemPrompt.length} chars, max ${MAX_SYSTEM_PROMPT_LENGTH})`);
  }

  // Permissions coherence.
  const execution = input.permissions?.execution;
  if (execution !== undefined && typeof execution !== "boolean") {
    errors.push("'permissions.execution' must be a boolean");
  }
  const allowProposals = input.riskPermissions?.allowTradeProposals;
  if (allowProposals !== undefined && typeof allowProposals !== "boolean") {
    errors.push("'riskPermissions.allowTradeProposals' must be a boolean");
  }
  const maxOrderSize = input.riskPermissions?.maxOrderSize;
  if (maxOrderSize !== undefined) {
    if (typeof maxOrderSize !== "number" || !Number.isFinite(maxOrderSize) || maxOrderSize <= 0) {
      errors.push("'riskPermissions.maxOrderSize' must be a positive number");
    } else if (maxOrderSize > MAX_COWORKER_ORDER_SIZE) {
      errors.push(`'riskPermissions.maxOrderSize' ${maxOrderSize} exceeds the creation cap of ${MAX_COWORKER_ORDER_SIZE} (raise it later via review, not at creation)`);
    }
  }
  if (allowProposals === true) {
    if (execution === false) {
      errors.push("'riskPermissions.allowTradeProposals: true' requires 'permissions.execution: true'");
    }
    if (tools && !tools.includes("create_trade_proposal")) {
      errors.push("'riskPermissions.allowTradeProposals: true' requires the 'create_trade_proposal' tool");
    }
  }

  if (errors.length > 0) return { ok: false, errors };

  // Existence checks against the live runtime.
  if (!(await deps.engineExists(engineDirty))) {
    return { ok: false, errors: [`unknown engine '${engineDirty}' (no provider registered for it)`] };
  }
  if (deps.idTaken && (await deps.idTaken(id))) {
    return { ok: false, errors: [`id '${id}' is already taken`] };
  }

  const normalized: NormalizedCoworker = {
    id,
    name: name as string,
    engine: engineDirty,
    systemPrompt: withSafetyRails(systemPrompt),
  };
  const description = cleanString(input.description, 500);
  if (description) normalized.description = description;
  const role = cleanString(input.role, 120);
  if (role) normalized.role = role;
  const model = typeof input.model === "string" && input.model.trim() ? input.model.trim().slice(0, 200) : undefined;
  if (model) normalized.model = model;
  if (tools && tools.length > 0) normalized.tools = tools;
  if (execution !== undefined) normalized.permissions = { execution };
  if (allowProposals !== undefined || maxOrderSize !== undefined) {
    normalized.riskPermissions = {};
    if (allowProposals !== undefined) normalized.riskPermissions.allowTradeProposals = allowProposals;
    if (maxOrderSize !== undefined) normalized.riskPermissions.maxOrderSize = maxOrderSize;
  }
  return { ok: true, errors: [], normalized };
}
