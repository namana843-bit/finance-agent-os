// ============================================================================
// Finance Agent OS — Protocol Transport
// Reusable framed transport for `rpc`-delivery (persistent-mode) adapters.
//
// Scope: newline-delimited JSON over an already-open byte stream (child
// stdio, socket). Plain argv/stdin CLIs never touch this module — their
// transport is the one-shot process path in `process-runner.ts`.
// ============================================================================

import type {
  ProtocolMessageHandler,
  ProtocolTransport,
} from "./types.js";

export interface JsonLineTransportStreams {
  write(data: string): void;
  onData(handler: (chunk: string) => void): () => void;
  onClose?(handler: () => void): () => void;
}

/**
 * Newline-delimited JSON transport. Malformed lines are dropped (counted in
 * `droppedLines`) — they must never break the connection or throw into the
 * caller. `close()` is idempotent.
 */
export class JsonLineTransport implements ProtocolTransport {
  readonly kind = "jsonline";
  private readonly streams: JsonLineTransportStreams;
  private readonly handlers = new Set<ProtocolMessageHandler>();
  private readonly offData: () => void;
  private readonly offClose: (() => void) | null;
  private buffer = "";
  private closed = false;
  droppedLines = 0;

  constructor(streams: JsonLineTransportStreams) {
    this.streams = streams;
    this.offData = streams.onData((chunk) => this.ingest(chunk));
    this.offClose =
      typeof streams.onClose === "function" ? streams.onClose(() => this.close()) : null;
  }

  isConnected(): boolean {
    return !this.closed;
  }

  send(message: unknown): void {
    if (this.closed) {
      throw new Error("Protocol transport is closed");
    }
    // Never interpolate into shell strings — structured JSON over the stream.
    this.streams.write(`${JSON.stringify(message)}\n`);
  }

  onMessage(handler: ProtocolMessageHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.offData();
    this.offClose?.();
    this.handlers.clear();
    this.buffer = "";
  }

  private ingest(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    const parts = this.buffer.split("\n");
    this.buffer = parts.pop() ?? "";
    for (const line of parts) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this.droppedLines += 1;
        continue;
      }
      for (const handler of [...this.handlers]) {
        try {
          handler(message);
        } catch {
          // A faulty subscriber must not break other subscribers.
        }
      }
    }
  }
}
