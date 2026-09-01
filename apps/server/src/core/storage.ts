import { mkdir, readFile, writeFile, access, rename, unlink } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------
// Persistence layer — file-based under `.data`
// ---------------------------------------------------------------------------

export interface Channel {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  updatedAt?: number;
}

export interface Thread {
  id: string;
  channelId: string;
  title: string;
  createdAt: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

export interface Message {
  id: string;
  threadId: string;
  channelId: string;
  role: string;
  content: string;
  timestamp: number;
  agentId?: string;
  data?: unknown;
}

export interface StorageState {
  channels: Channel[];
  threads: Thread[];
  messages: Message[];
}

type CollectionName = "channels" | "threads" | "messages";

function getDataDir(): string {
  // Resolve relative to the compiled file or source — fallback to cwd
  // In dev (tsx) __dirname is src/core, in prod dist/core
  // We want <project_root>/.data  =>  apps/server/.data
  // Walk up from this file's directory to find server root.
  try {
    const currentDir = dirname(fileURLToPath(import.meta.url));
    // src/core -> src -> server  (2 levels up from core)
    // dist/core -> dist -> server (2 levels up)
    const serverRoot = join(currentDir, "..", "..");
    return join(serverRoot, ".data");
  } catch {
    return join(process.cwd(), ".data");
  }
}

export class Storage {
  private readonly dataDir: string;

  constructor(dataDir?: string) {
    this.dataDir = dataDir ?? getDataDir();
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  async ensureDir(): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
  }

  getDataDirPath(): string {
    return this.dataDir;
  }

  // -------------------------------------------------------------------------
  // Generic collection helpers
  // -------------------------------------------------------------------------

  private filePath(collection: CollectionName): string {
    return join(this.dataDir, `${collection}.json`);
  }

  private async readCollection<T>(collection: CollectionName): Promise<T[]> {
    const path = this.filePath(collection);
    try {
      await access(path);
    } catch {
      return [];
    }
    try {
      const raw = await readFile(path, "utf-8");
      if (!raw.trim()) return [];
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        console.warn(`[storage] ${collection}.json is not an array, resetting`);
        return [];
      }
      return parsed as T[];
    } catch (err) {
      console.error(`[storage] failed to read ${collection}:`, err);
      return [];
    }
  }

  private async writeCollection<T>(
    collection: CollectionName,
    data: T[],
  ): Promise<void> {
    await this.ensureDir();
    const path = this.filePath(collection);
    const tmpPath = `${path}.tmp`;
    const payload = JSON.stringify(data, null, 2);
    try {
      // Write to tmp first for atomicity, then rename; fallback to direct write on UNC/Windows
      await writeFile(tmpPath, payload, "utf-8");
      try {
        await rename(tmpPath, path);
      } catch {
        // rename may fail on Windows UNC shares — fallback to direct write
        await writeFile(path, payload, "utf-8");
        try {
          await unlink(tmpPath);
        } catch {
          // ignore cleanup errors
        }
      }
    } catch (err) {
      console.error(`[storage] failed to write ${collection}:`, err);
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Channels
  // -------------------------------------------------------------------------

  async getChannels(): Promise<Channel[]> {
    return this.readCollection<Channel>("channels");
  }

  async getChannel(id: string): Promise<Channel | undefined> {
    const channels = await this.getChannels();
    return channels.find((c) => c.id === id);
  }

  async saveChannel(channel: Channel): Promise<Channel> {
    const channels = await this.getChannels();
    const idx = channels.findIndex((c) => c.id === channel.id);
    const now = Date.now();
    const toSave: Channel = {
      ...channel,
      updatedAt: now,
      createdAt: channel.createdAt ?? now,
    };
    if (idx >= 0) {
      channels[idx] = toSave;
    } else {
      channels.push(toSave);
    }
    await this.writeCollection("channels", channels);
    return toSave;
  }

  // -------------------------------------------------------------------------
  // Threads
  // -------------------------------------------------------------------------

  async getThreads(channelId?: string): Promise<Thread[]> {
    const threads = await this.readCollection<Thread>("threads");
    if (channelId) {
      return threads.filter((t) => t.channelId === channelId);
    }
    return threads;
  }

  async getThread(id: string): Promise<Thread | undefined> {
    const threads = await this.getThreads();
    return threads.find((t) => t.id === id);
  }

  async saveThread(thread: Thread): Promise<Thread> {
    const threads = await this.readCollection<Thread>("threads");
    const idx = threads.findIndex((t) => t.id === thread.id);
    const now = Date.now();
    const toSave: Thread = {
      ...thread,
      updatedAt: now,
      createdAt: thread.createdAt ?? now,
    };
    if (idx >= 0) {
      threads[idx] = toSave;
    } else {
      threads.push(toSave);
    }
    await this.writeCollection("threads", threads);
    return toSave;
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  async getMessages(filter?: {
    threadId?: string;
    channelId?: string;
    limit?: number;
  }): Promise<Message[]> {
    let messages = await this.readCollection<Message>("messages");
    if (filter?.threadId) {
      messages = messages.filter((m) => m.threadId === filter.threadId);
    }
    if (filter?.channelId) {
      messages = messages.filter((m) => m.channelId === filter.channelId);
    }
    // Sort by timestamp ascending
    messages.sort((a, b) => a.timestamp - b.timestamp);
    if (filter?.limit !== undefined && filter.limit !== null) {
      messages = messages.slice(-filter.limit);
    }
    return messages;
  }

  async saveMessage(message: Message): Promise<Message> {
    const messages = await this.readCollection<Message>("messages");
    const idx = messages.findIndex((m) => m.id === message.id);
    if (idx >= 0) {
      messages[idx] = message;
    } else {
      messages.push(message);
    }
    await this.writeCollection("messages", messages);
    return message;
  }

  async appendMessage(message: Message): Promise<Message> {
    return this.saveMessage(message);
  }

  // -------------------------------------------------------------------------
  // Aggregate state
  // -------------------------------------------------------------------------

  async getState(): Promise<StorageState> {
    const [channels, threads, messages] = await Promise.all([
      this.getChannels(),
      this.getThreads(),
      this.getMessages(),
    ]);
    return { channels, threads, messages };
  }

  /**
   * Seed default data if collections are empty.
   * Useful for first-run / demo.
   */
  async seedIfEmpty(): Promise<void> {
    await this.ensureDir();
    const [channels, threads] = await Promise.all([
      this.getChannels(),
      this.getThreads(),
    ]);

    if (channels.length === 0) {
      const now = Date.now();
      const defaultChannels: Channel[] = [
        {
          id: "general",
          name: "general",
          description: "General finance discussions",
          createdAt: now,
        },
        {
          id: "market",
          name: "market",
          description: "Market data & ticks",
          createdAt: now,
        },
        {
          id: "portfolio",
          name: "portfolio",
          description: "Portfolio & positions",
          createdAt: now,
        },
      ];
      await this.writeCollection("channels", defaultChannels);
    }

    if (threads.length === 0) {
      const channelsAfter = await this.getChannels();
      if (channelsAfter.length > 0) {
        const now = Date.now();
        const defaultThread: Thread = {
          id: "welcome",
          channelId: channelsAfter[0]!.id,
          title: "Welcome to Finance Agent OS",
          createdAt: now,
        };
        await this.writeCollection("threads", [defaultThread]);
      }
    }

    const messages = await this.getMessages();
    if (messages.length === 0) {
      const now = Date.now();
      const welcome: Message = {
        id: "welcome-1",
        threadId: "welcome",
        channelId: "general",
        role: "system",
        content: "Finance Agent OS initialized. Agents: Market → Quant → Risk → Portfolio → Execution",
        timestamp: now,
      };
      await this.writeCollection("messages", [welcome]);
    }
  }
}

// Singleton default storage
export const storage = new Storage();

export default Storage;
