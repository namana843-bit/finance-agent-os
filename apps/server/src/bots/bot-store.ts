// Finance Agent OS — BotStore (Step 1: persistent data model for custom bots)
//
// Typed repository over the Prisma models BotProfile / BotSession /
// BotMessage / ProviderSessionMapping (see prisma/schema.prisma).
//
// Design notes:
// - The client is INJECTED (constructor), so tests run against an isolated
//   SQLite file and production passes a shared singleton. This module never
//   opens the dev database by itself.
// - This is persistence only. It does NOT duplicate runtime session
//   infrastructure: CliSessionManager still owns live CLI processes and
//   AgentRuntime still owns the reasoning loop. ProviderSessionMapping only
//   records the external session id needed for resumption.
// - Data-retention policy: default lifecycle is soft (archive). Hard delete
//   is explicit via purgeBot(), which removes children first in one
//   transaction. FKs are Restrict, so accidental direct deletes fail.
// - Secrets policy: settingsJson / systemPrompt are scanned for obvious
//   secret keys before write; matches are rejected, never stored.

import type { PrismaClient } from "@prisma/client";

export const BOT_STATUSES = ["active", "archived"] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

export const BOT_SESSION_STATUSES = ["active", "closed", "archived"] as const;
export type BotSessionStatus = (typeof BOT_SESSION_STATUSES)[number];

export const BOT_MESSAGE_ROLES = ["user", "assistant", "tool", "system"] as const;
export type BotMessageRole = (typeof BOT_MESSAGE_ROLES)[number];

/** Key fragments that must never appear in stored bot config text. */
const SECRET_KEY_PATTERN = /(api[_-]?key|api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token|private[_-]?key|password|passwd|credential|client[_-]?secret)\s*["':=]/i;

export class BotStoreError extends Error {
  readonly code: "VALIDATION" | "NOT_FOUND" | "CONFLICT" | "STORAGE";
  constructor(code: BotStoreError["code"], message: string) {
    super(message);
    this.name = "BotStoreError";
    this.code = code;
  }
}

export interface CreateBotInput {
  name: string;
  description?: string;
  systemPrompt: string;
  engine: string;
  model?: string;
  /** Provider settings as an object; serialized to settingsJson. Never secrets. */
  settings?: Record<string, unknown>;
  tools?: string[];
  ownerId?: string;
}

export interface UpdateBotInput {
  name?: string;
  description?: string | null;
  systemPrompt?: string;
  engine?: string;
  model?: string | null;
  settings?: Record<string, unknown>;
  tools?: string[];
  ownerId?: string | null;
}

export interface CreateSessionInput {
  botId: string;
  title?: string;
  /** Session-specific config (cwd, temperature, …). Never secrets. */
  config?: Record<string, unknown>;
}

function assertNoSecrets(text: string, field: string): void {
  if (SECRET_KEY_PATTERN.test(text)) {
    throw new BotStoreError(
      "VALIDATION",
      `'${field}' looks like it contains a secret (api key / token / password). Secrets must never be stored in bot profiles.`,
    );
  }
}

function toJson(value: Record<string, unknown> | undefined, field: string): string | undefined {
  if (value === undefined) return undefined;
  const text = JSON.stringify(value);
  assertNoSecrets(text, field);
  return text;
}

export class BotStore {
  constructor(private readonly db: PrismaClient) {}

  // -- Bot profiles -------------------------------------------------------

  async createBot(input: CreateBotInput) {
    const name = input.name?.trim();
    if (!name || name.length > 80) {
      throw new BotStoreError("VALIDATION", "'name' is required (max 80 chars)");
    }
    if (!input.systemPrompt?.trim()) {
      throw new BotStoreError("VALIDATION", "'systemPrompt' is required");
    }
    if (!input.engine?.trim()) {
      throw new BotStoreError("VALIDATION", "'engine' is required");
    }
    assertNoSecrets(input.systemPrompt, "systemPrompt");
    try {
      return await this.db.botProfile.create({
        data: {
          name,
          description: input.description?.trim() || null,
          systemPrompt: input.systemPrompt.trim(),
          engine: input.engine.trim(),
          model: input.model?.trim() || null,
          settingsJson: toJson(input.settings, "settings") ?? "{}",
          toolsJson: input.tools ? JSON.stringify([...new Set(input.tools)]) : "[]",
          ownerId: input.ownerId ?? null,
        },
      });
    } catch (err) {
      throw this.wrap(err, "create bot");
    }
  }

  async getBot(id: string) {
    const bot = await this.db.botProfile.findUnique({ where: { id } });
    if (!bot) throw new BotStoreError("NOT_FOUND", `bot '${id}' not found`);
    return bot;
  }

  async listBots(opts: { status?: BotStatus; ownerId?: string } = {}) {
    return this.db.botProfile.findMany({
      where: {
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.ownerId ? { ownerId: opts.ownerId } : {}),
      },
      orderBy: { createdAt: "desc" },
    });
  }

  async updateBot(id: string, input: UpdateBotInput) {
    await this.getBot(id);
    if (input.name !== undefined && (!input.name.trim() || input.name.trim().length > 80)) {
      throw new BotStoreError("VALIDATION", "'name' must be 1-80 chars");
    }
    if (input.systemPrompt !== undefined) {
      if (!input.systemPrompt.trim()) throw new BotStoreError("VALIDATION", "'systemPrompt' must not be empty");
      assertNoSecrets(input.systemPrompt, "systemPrompt");
    }
    if (input.engine !== undefined && !input.engine.trim()) {
      throw new BotStoreError("VALIDATION", "'engine' must not be empty");
    }
    try {
      return await this.db.botProfile.update({
        where: { id },
        data: {
          ...(input.name !== undefined ? { name: input.name.trim() } : {}),
          ...(input.description !== undefined ? { description: input.description?.trim() || null } : {}),
          ...(input.systemPrompt !== undefined ? { systemPrompt: input.systemPrompt.trim() } : {}),
          ...(input.engine !== undefined ? { engine: input.engine.trim() } : {}),
          ...(input.model !== undefined ? { model: input.model?.trim() || null } : {}),
          ...(input.settings !== undefined ? { settingsJson: toJson(input.settings, "settings") ?? "{}" } : {}),
          ...(input.tools !== undefined ? { toolsJson: JSON.stringify([...new Set(input.tools)]) } : {}),
          ...(input.ownerId !== undefined ? { ownerId: input.ownerId } : {}),
        },
      });
    } catch (err) {
      throw this.wrap(err, "update bot");
    }
  }

  /** Soft-delete (default path): data retained, hidden from active lists. */
  async archiveBot(id: string) {
    await this.getBot(id);
    return this.db.botProfile.update({ where: { id }, data: { status: "archived" } });
  }

  async unarchiveBot(id: string) {
    await this.getBot(id);
    return this.db.botProfile.update({ where: { id }, data: { status: "active" } });
  }

  /**
   * Explicit hard delete only. Removes mappings -> messages -> sessions ->
   * bot in one transaction. Direct `db.botProfile.delete` on a bot with
   * children fails (Restrict) — that is intentional.
   */
  async purgeBot(id: string): Promise<{ deletedSessions: number; deletedMessages: number }> {
    await this.getBot(id);
    const sessions = await this.db.botSession.findMany({ where: { botId: id }, select: { id: true } });
    const sessionIds = sessions.map((s) => s.id);
    return this.db.$transaction(async (tx) => {
      if (sessionIds.length > 0) {
        await tx.providerSessionMapping.deleteMany({ where: { sessionId: { in: sessionIds } } });
      }
      const messages = sessionIds.length > 0
        ? await tx.botMessage.deleteMany({ where: { sessionId: { in: sessionIds } } })
        : { count: 0 };
      const deletedSessions = sessionIds.length > 0
        ? (await tx.botSession.deleteMany({ where: { botId: id } })).count
        : 0;
      await tx.botProfile.delete({ where: { id } });
      return { deletedSessions, deletedMessages: messages.count };
    });
  }

  // -- Bot sessions --------------------------------------------------------

  async createSession(input: CreateSessionInput) {
    await this.getBot(input.botId);
    try {
      return await this.db.botSession.create({
        data: {
          botId: input.botId,
          title: input.title?.trim() || null,
          configJson: toJson(input.config, "config") ?? "{}",
        },
      });
    } catch (err) {
      throw this.wrap(err, "create session");
    }
  }

  async getSession(id: string) {
    const session = await this.db.botSession.findUnique({ where: { id } });
    if (!session) throw new BotStoreError("NOT_FOUND", `session '${id}' not found`);
    return session;
  }

  /** Sessions of one bot only — never leaks across bots. */
  async listSessionsByBot(botId: string, opts: { status?: BotSessionStatus } = {}) {
    return this.db.botSession.findMany({
      where: { botId, ...(opts.status ? { status: opts.status } : {}) },
      orderBy: { createdAt: "desc" },
    });
  }

  async closeSession(id: string) {
    await this.getSession(id);
    return this.db.botSession.update({
      where: { id },
      data: { status: "closed", closedAt: new Date() },
    });
  }

  // -- Messages -------------------------------------------------------------

  async addMessage(sessionId: string, role: BotMessageRole, content: string, metadata?: Record<string, unknown>) {
    if (!(BOT_MESSAGE_ROLES as readonly string[]).includes(role)) {
      throw new BotStoreError("VALIDATION", `'role' must be one of ${BOT_MESSAGE_ROLES.join(", ")}`);
    }
    if (!content || !content.trim()) {
      throw new BotStoreError("VALIDATION", "'content' must not be empty");
    }
    await this.getSession(sessionId);
    try {
      return await this.db.botMessage.create({
        data: {
          sessionId,
          role,
          content,
          metadataJson: metadata ? JSON.stringify(metadata) : "{}",
        },
      });
    } catch (err) {
      throw this.wrap(err, "add message");
    }
  }

  /** Messages of one session, chronological. Session-scoped by construction. */
  async listMessages(sessionId: string, opts: { limit?: number } = {}) {
    await this.getSession(sessionId);
    return this.db.botMessage.findMany({
      where: { sessionId },
      orderBy: { createdAt: "asc" },
      ...(opts.limit ? { take: opts.limit } : {}),
    });
  }

  // -- Provider session mapping ---------------------------------------------

  /**
   * Record/refresh the external CLI session id for resumption.
   * Upsert on (sessionId, providerId): at most one external id per provider.
   */
  async upsertProviderMapping(sessionId: string, providerId: string, externalSessionId: string) {
    if (!providerId.trim()) throw new BotStoreError("VALIDATION", "'providerId' is required");
    if (!externalSessionId.trim()) throw new BotStoreError("VALIDATION", "'externalSessionId' is required");
    await this.getSession(sessionId);
    try {
      return await this.db.providerSessionMapping.upsert({
        where: { sessionId_providerId: { sessionId, providerId: providerId.trim() } },
        create: { sessionId, providerId: providerId.trim(), externalSessionId: externalSessionId.trim() },
        update: { externalSessionId: externalSessionId.trim() },
      });
    } catch (err) {
      throw this.wrap(err, "upsert provider mapping");
    }
  }

  async getProviderMapping(sessionId: string, providerId: string) {
    return this.db.providerSessionMapping.findUnique({
      where: { sessionId_providerId: { sessionId, providerId } },
    });
  }

  private wrap(err: unknown, action: string): Error {
    if (err instanceof BotStoreError) return err;
    const code = (err as { code?: string })?.code;
    if (code === "P2003" || code === "P2002") {
      return new BotStoreError("CONFLICT", `cannot ${action}: related record constraint (${code})`);
    }
    if (code === "P2025") {
      return new BotStoreError("NOT_FOUND", `cannot ${action}: record not found`);
    }
    return new BotStoreError("STORAGE", `cannot ${action}: ${(err as Error)?.message ?? String(err)}`);
  }
}
