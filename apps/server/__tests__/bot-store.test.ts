// BotStore (Step 1) — persistence, session isolation, relationships.
// Uses an isolated temp SQLite file + `prisma db push`. Never touches dev.db.
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaClient } from "@prisma/client";
import { BotStore } from "../src/bots/bot-store.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCHEMA = join(HERE, "..", "..", "..", "prisma", "schema.prisma");
const NPX = process.platform === "win32" ? "npx.cmd" : "npx";

let dir: string;
let db: PrismaClient;
let store: BotStore;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fao-botstore-"));
  const url = `file:${join(dir, "test.db")}`;
  execFileSync(NPX, ["prisma", "db", "push", "--schema", SCHEMA], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
    // .cmd shims only spawn via a shell on Windows.
    shell: process.platform === "win32",
  });
  db = new PrismaClient({ datasourceUrl: url } as ConstructorParameters<typeof PrismaClient>[0]);
  store = new BotStore(db);
}, 60_000);

afterAll(async () => {
  await db?.$disconnect();
});

describe("bot profiles", () => {
  it("creates, reads, lists, and updates a bot", async () => {
    const bot = await store.createBot({
      name: "ETH Scout",
      description: "Watches ETH",
      systemPrompt: "You are an ETH strategy researcher. Use only tool outputs.",
      engine: "cline",
      model: "default",
      settings: { temperature: 0.2 },
      tools: ["get_ohlcv", "calculate_rsi", "get_ohlcv"],
    });
    expect(bot.id).toBeTruthy();
    expect(bot.status).toBe("active");
    expect(JSON.parse(bot.toolsJson)).toEqual(["get_ohlcv", "calculate_rsi"]);

    expect((await store.getBot(bot.id)).name).toBe("ETH Scout");
    expect(await store.listBots()).toHaveLength(1);

    const updated = await store.updateBot(bot.id, { model: "pro", tools: ["get_market_price"] });
    expect(updated.model).toBe("pro");
    expect(JSON.parse(updated.toolsJson)).toEqual(["get_market_price"]);
  });

  it("rejects missing fields", async () => {
    await expect(store.createBot({ name: "", systemPrompt: "x", engine: "cline" })).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      store.createBot({ name: "NoEngine", systemPrompt: "does research work", engine: "" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("refuses to store secrets in systemPrompt and settings", async () => {
    await expect(
      store.createBot({
        name: "Shady",
        systemPrompt: "Use this config please with sufficient detail for the team.",
        engine: "cline",
        settings: { api_key: "sk-live-123" },
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      store.createBot({
        name: "Shady2",
        systemPrompt: "Authenticate with password: hunter2 to proceed with analysis work.",
        engine: "cline",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("throws NOT_FOUND for unknown bots", async () => {
    await expect(store.getBot("nope")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("sessions and messages", () => {
  it("isolates messages per session and per bot", async () => {
    const a = await store.createBot({ name: "Bot A", systemPrompt: "Research equities with sufficient detail.", engine: "cline" });
    const b = await store.createBot({ name: "Bot B", systemPrompt: "Research crypto with sufficient detail.", engine: "codex" });
    const s1 = await store.createSession({ botId: a.id, title: "morning scan" });
    const s2 = await store.createSession({ botId: a.id });
    const s3 = await store.createSession({ botId: b.id });

    await store.addMessage(s1.id, "user", "scan BTC");
    await store.addMessage(s1.id, "assistant", "BTC RSI is 42.");
    await store.addMessage(s2.id, "user", "other thread");

    expect((await store.listMessages(s1.id)).map((m) => m.content)).toEqual(["scan BTC", "BTC RSI is 42."]);
    expect((await store.listMessages(s2.id)).map((m) => m.content)).toEqual(["other thread"]);
    expect(await store.listMessages(s3.id)).toEqual([]);

    expect((await store.listSessionsByBot(a.id)).map((s) => s.id).sort()).toEqual([s1.id, s2.id].sort());
    expect((await store.listSessionsByBot(b.id)).map((s) => s.id)).toEqual([s3.id]);

    const closed = await store.closeSession(s1.id);
    expect(closed.status).toBe("closed");
    expect(closed.closedAt).toBeTruthy();
  });

  it("rejects bad roles and empty content", async () => {
    const bot = await store.createBot({ name: "Strict", systemPrompt: "Research forex with sufficient detail.", engine: "cline" });
    const s = await store.createSession({ botId: bot.id });
    await expect(store.addMessage(s.id, "alien" as never, "hi")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(store.addMessage(s.id, "user", "   ")).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(store.createSession({ botId: "missing" })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("provider session mapping", () => {
  it("upserts one external id per (session, provider)", async () => {
    const bot = await store.createBot({ name: "Resume Bot", systemPrompt: "Research with resumption support enabled.", engine: "cline" });
    const s = await store.createSession({ botId: bot.id });

    await store.upsertProviderMapping(s.id, "cline", "ext-1");
    expect((await store.getProviderMapping(s.id, "cline"))?.externalSessionId).toBe("ext-1");

    // Same provider, new external id -> update in place, still one row.
    await store.upsertProviderMapping(s.id, "cline", "ext-2");
    expect((await store.getProviderMapping(s.id, "cline"))?.externalSessionId).toBe("ext-2");

    // Different provider -> separate row.
    await store.upsertProviderMapping(s.id, "codex", "cx-9");
    expect((await store.getProviderMapping(s.id, "codex"))?.externalSessionId).toBe("cx-9");

    expect(await store.getProviderMapping(s.id, "gemini")).toBeNull();
  });
});

describe("retention policy", () => {
  it("archives by default (data retained), purge removes everything", async () => {
    const bot = await store.createBot({ name: "Doomed", systemPrompt: "Temporary research assistant for markets.", engine: "cline" });
    const s = await store.createSession({ botId: bot.id });
    await store.addMessage(s.id, "user", "hello");
    await store.upsertProviderMapping(s.id, "cline", "ext-x");

    const archived = await store.archiveBot(bot.id);
    expect(archived.status).toBe("archived");
    // Data still there after archive.
    expect((await store.listMessages(s.id))).toHaveLength(1);
    expect(await store.listBots({ status: "active" })).not.toContainEqual(expect.objectContaining({ id: bot.id }));

    // Direct delete is blocked by Restrict while children exist.
    await expect(db.botProfile.delete({ where: { id: bot.id } })).rejects.toThrow();

    const purged = await store.purgeBot(bot.id);
    expect(purged).toEqual({ deletedSessions: 1, deletedMessages: 1 });
    await expect(store.getBot(bot.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("purges a bot with no sessions", async () => {
    const bot = await store.createBot({ name: "Empty", systemPrompt: "Empty bot with sufficient detail here.", engine: "cline" });
    await expect(store.purgeBot(bot.id)).resolves.toEqual({ deletedSessions: 0, deletedMessages: 0 });
  });
});
