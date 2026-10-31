import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_DIR } from "../config.js";
import type { AgentConfig } from "./agent-runtime.js";
import type { EngineConfig, LLMMessage } from "@finance/shared";

function defaultDataDir(): string {
  return process.env.FINANCE_DATA_DIR || DATA_DIR;
}

export class AgentPersistence {
  private readonly dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? defaultDataDir();
  }

  private agentsFilePath(): string {
    return join(this.dataDir, "agents.json");
  }

  private conversationsDir(): string {
    return join(this.dataDir, "conversations");
  }

  private conversationFilePath(agentId: string, conversationId?: string): string {
    const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const safeConv = (conversationId ?? agentId).replace(/[^a-zA-Z0-9_-]/g, "_");
    const dir = join(this.conversationsDir(), safeAgent);
    return join(dir, `${safeConv}.json`);
  }

  async loadAgents(): Promise<AgentConfig[]> {
    try {
      const content = await readFile(this.agentsFilePath(), "utf-8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed as AgentConfig[];
      }
      return [];
    } catch {
      return [];
    }
  }

  async saveAgents(agents: AgentConfig[]): Promise<void> {
    try {
      await mkdir(this.dataDir, { recursive: true });
      const filePath = this.agentsFilePath();
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmpPath, JSON.stringify(agents, null, 2), "utf-8");
      await rename(tmpPath, filePath);
    } catch (err) {
      console.error("[AgentPersistence] Failed to save agents:", err);
    }
  }

  async loadConversation(agentId: string, conversationId?: string): Promise<LLMMessage[]> {
    try {
      const content = await readFile(this.conversationFilePath(agentId, conversationId), "utf-8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed as LLMMessage[];
      }
      return [];
    } catch {
      return [];
    }
  }

  /** All conversations for one agent (per-conversation files + legacy default). */
  async loadConversations(agentId: string): Promise<Map<string, LLMMessage[]>> {
    const conversations = new Map<string, LLMMessage[]>();
    const safeAgent = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const agentDir = join(this.conversationsDir(), safeAgent);
    try {
      const entries = await readdir(agentDir);
      for (const entry of entries) {
        if (!entry.endsWith(".json")) continue;
        const conversationId = entry.slice(0, -5);
        const messages = await readFile(join(agentDir, entry), "utf-8")
          .then((c) => JSON.parse(c))
          .catch(() => []);
        if (Array.isArray(messages)) conversations.set(conversationId, messages as LLMMessage[]);
      }
    } catch {
      // No conversation directory yet — fall through to the legacy default.
    }
    const legacy = await this.loadConversation(agentId);
    if (legacy.length > 0 && !conversations.has(agentId)) {
      conversations.set(agentId, legacy);
    }
    return conversations;
  }

  async saveConversation(agentId: string, conversationId: string, messages: LLMMessage[]): Promise<void> {
    try {
      const dir = join(this.conversationsDir(), agentId.replace(/[^a-zA-Z0-9_-]/g, "_"));
      await mkdir(dir, { recursive: true });
      const filePath = this.conversationFilePath(agentId, conversationId);
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmpPath, JSON.stringify(messages, null, 2), "utf-8");
      await rename(tmpPath, filePath);
    } catch (err) {
      console.error(`[AgentPersistence] Failed to save conversation for ${agentId}/${conversationId}:`, err);
    }
  }
}
