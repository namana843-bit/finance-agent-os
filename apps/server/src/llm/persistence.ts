import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

  private conversationFilePath(agentId: string): string {
    const safeId = agentId.replace(/[^a-zA-Z0-9_-]/g, "_");
    return join(this.conversationsDir(), `${safeId}.json`);
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

  async loadConversation(agentId: string): Promise<LLMMessage[]> {
    try {
      const content = await readFile(this.conversationFilePath(agentId), "utf-8");
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return parsed as LLMMessage[];
      }
      return [];
    } catch {
      return [];
    }
  }

  async saveConversation(agentId: string, messages: LLMMessage[]): Promise<void> {
    try {
      const dir = this.conversationsDir();
      await mkdir(dir, { recursive: true });
      const filePath = this.conversationFilePath(agentId);
      const tmpPath = `${filePath}.${process.pid}.tmp`;
      await writeFile(tmpPath, JSON.stringify(messages, null, 2), "utf-8");
      await rename(tmpPath, filePath);
    } catch (err) {
      console.error(`[AgentPersistence] Failed to save conversation for ${agentId}:`, err);
    }
  }
}
