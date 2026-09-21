// ============================================================================
// Finance Agent OS — OpenCode Persistent Daemon Service
// Manages a background `opencode serve --port 4096 --pure` instance to eliminate
// cold process boot overhead (2.5s - 5.0s) during interactive agent calls.
// ============================================================================

import { spawn, type ChildProcess } from "node:child_process";
import { resolveOpencodeCliPath } from "./opencode-cli-gateway.js";

export interface OpencodeDaemonConfig {
  enabled: boolean;
  port: number;
  hostname: string;
  pure: boolean;
}

export class OpencodeDaemonManager {
  private static instance: OpencodeDaemonManager | null = null;
  private process: ChildProcess | null = null;
  private config: OpencodeDaemonConfig;
  private isRunning = false;

  constructor(config?: Partial<OpencodeDaemonConfig>) {
    const port = Number(process.env.OPENCODE_DAEMON_PORT) || 4096;
    const enabled = process.env.OPENCODE_DAEMON_ENABLED !== "false";
    this.config = {
      enabled: config?.enabled ?? enabled,
      port: config?.port ?? port,
      hostname: config?.hostname ?? "127.0.0.1",
      pure: config?.pure ?? true,
    };
    OpencodeDaemonManager.instance = this;
  }

  static getInstance(): OpencodeDaemonManager | null {
    return OpencodeDaemonManager.instance;
  }

  getDaemonUrl(): string | null {
    if (!this.config.enabled || !this.isRunning) return null;
    return `http://${this.config.hostname}:${this.config.port}`;
  }

  async checkHealth(): Promise<boolean> {
    try {
      const url = `http://${this.config.hostname}:${this.config.port}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 1000);
      const res = await fetch(url, { signal: controller.signal }).catch(() => null);
      clearTimeout(timer);
      return !!res;
    } catch {
      return false;
    }
  }

  async start(): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    // Check if a daemon is already running on the target port
    const alreadyUp = await this.checkHealth();
    if (alreadyUp) {
      this.isRunning = true;
      console.log(`[opencode:daemon] existing daemon detected at http://${this.config.hostname}:${this.config.port}`);
      return;
    }

    const cliInfo = resolveOpencodeCliPath();
    const binPath = cliInfo.resolvedPath || cliInfo.cliPath;
    if (!binPath || !cliInfo.exists) {
      console.warn(`[opencode:daemon] executable not found, daemon start deferred`);
      return;
    }

    const args: string[] = [
      "serve",
      "--port",
      String(this.config.port),
      "--hostname",
      this.config.hostname,
    ];
    if (this.config.pure) {
      args.push("--pure");
    }

    try {
      const useShell = binPath.endsWith(".cmd") || binPath.endsWith(".bat") || binPath.endsWith(".ps1");
      this.process = spawn(binPath, args, {
        detached: false,
        shell: useShell,
        stdio: ["ignore", "pipe", "pipe"],
      });

      this.process.on("error", (err) => {
        console.warn(`[opencode:daemon] process error: ${err.message}`);
        this.isRunning = false;
      });

      this.process.on("exit", (code) => {
        console.log(`[opencode:daemon] process exited with code ${code}`);
        this.isRunning = false;
        this.process = null;
      });

      // Poll readiness up to 3 seconds
      for (let i = 0; i < 15; i++) {
        await new Promise((r) => setTimeout(r, 200));
        if (await this.checkHealth()) {
          this.isRunning = true;
          console.log(`[opencode:daemon] active and listening at http://${this.config.hostname}:${this.config.port}`);
          return;
        }
      }

      console.warn(`[opencode:daemon] startup timed out; falling back to direct CLI mode`);
    } catch (err) {
      console.warn(`[opencode:daemon] failed to spawn: ${err instanceof Error ? err.message : String(err)}`);
      this.isRunning = false;
    }
  }

  stop(): void {
    if (this.process) {
      try {
        this.process.kill();
      } catch {}
      this.process = null;
    }
    this.isRunning = false;
    console.log("[opencode:daemon] daemon stopped");
  }
}
