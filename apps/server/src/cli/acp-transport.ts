// ============================================================================
// Finance Agent OS — Shared ACP (Agent Client Protocol) connection module.
//
// Scope: JSON-RPC 2.0 message framing + request/response demultiplexing over
// an already-open byte stream (child stdio, socket). This module knows the
// wire framing only — provider handshakes (initialize/authenticate) belong
// in each provider adapter, which configures a connection instead of
// duplicating transport logic.
//
// Status: transport-tested with mocked streams. No provider adapter routes
// live traffic through it yet — Cursor documents `agent acp` (ACP server
// over stdio) and is the first planned consumer (see cursor-adapter.ts).
// ============================================================================

export interface AcpStreams {
  write(data: string): void;
  onData(handler: (chunk: string) => void): () => void;
  onClose?(handler: () => void): () => void;
}

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const HEADER_RE = /content-length:\s*(\d+)/i;

/**
 * Minimal ACP/JSON-RPC connection: Content-Length framed messages over a
 * byte stream, with request id demux, per-request timeouts and notification
 * subscription. Never throws into subscribers; `close()` is idempotent.
 */
export class AcpConnection {
  private readonly streams: AcpStreams;
  private readonly offData: () => void;
  private readonly offClose: (() => void) | null;
  private readonly pending = new Map<number | string, PendingRequest>();
  private readonly notificationHandlers = new Set<(method: string, params: unknown) => void>();
  private readonly responseHandlers = new Set<(message: Record<string, unknown>) => void>();
  private buffer = "";
  private nextId = 1;
  private closed = false;
  private readonly defaultTimeoutMs: number;

  constructor(streams: AcpStreams, opts?: { defaultTimeoutMs?: number }) {
    this.streams = streams;
    this.defaultTimeoutMs = opts?.defaultTimeoutMs ?? 60_000;
    this.offData = streams.onData((chunk) => this.ingest(chunk));
    this.offClose =
      typeof streams.onClose === "function" ? streams.onClose(() => this.close()) : null;
  }

  isConnected(): boolean {
    return !this.closed;
  }

  /** Subscribe to JSON-RPC notifications / responses (for adapter bridges). */
  onNotification(handler: (method: string, params: unknown) => void): () => void {
    this.notificationHandlers.add(handler);
    return () => {
      this.notificationHandlers.delete(handler);
    };
  }

  /** Observe every parsed protocol message (logging / protocol tests). */
  onMessage(handler: (message: Record<string, unknown>) => void): () => void {
    this.responseHandlers.add(handler);
    return () => {
      this.responseHandlers.delete(handler);
    };
  }

  /** Send a JSON-RPC request; rejects on timeout or after close. */
  request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new Error("ACP connection is closed"));
    }
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: "2.0", id, method, params });
    const frame = `Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP request '${method}' timed out`));
      }, timeoutMs ?? this.defaultTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.streams.write(frame);
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): void {
    if (this.closed) {
      throw new Error("ACP connection is closed");
    }
    const body = JSON.stringify({ jsonrpc: "2.0", method, params });
    this.streams.write(`Content-Length: ${Buffer.byteLength(body, "utf-8")}\r\n\r\n${body}`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.offData();
    this.offClose?.();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ACP connection closed"));
      this.pending.delete(id);
    }
    this.notificationHandlers.clear();
    this.responseHandlers.clear();
    this.buffer = "";
  }

  private ingest(chunk: string): void {
    if (this.closed) return;
    this.buffer += chunk;
    for (;;) {
      const message = this.extractFrame();
      if (message === null) return;
      this.dispatch(message);
    }
  }

  private extractFrame(): Record<string, unknown> | null {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return null;
    const header = this.buffer.slice(0, headerEnd);
    const match = HEADER_RE.exec(header);
    if (!match) {
      // Unframed line — drop it rather than desyncing the stream.
      this.buffer = this.buffer.slice(headerEnd + 4);
      return null;
    }
    const length = Number.parseInt(match[1] ?? "", 10);
    const start = headerEnd + 4;
    if (this.buffer.length < start + length) return null;
    const body = this.buffer.slice(start, start + length);
    this.buffer = this.buffer.slice(start + length);
    try {
      const parsed = JSON.parse(body) as unknown;
      return parsed && typeof parsed === "object"
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }

  private dispatch(message: Record<string, unknown>): void {
    for (const handler of [...this.responseHandlers]) {
      try {
        handler(message);
      } catch {
        // Faulty observers must not break protocol handling.
      }
    }
    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id as number | string);
      if (!pending) return;
      this.pending.delete(message.id as number | string);
      clearTimeout(pending.timer);
      if (Object.prototype.hasOwnProperty.call(message, "error")) {
        const error = message.error as { message?: unknown };
        pending.reject(
          new Error(
            typeof error?.message === "string" ? error.message : "ACP request failed",
          ),
        );
        return;
      }
      pending.resolve((message as { result?: unknown }).result);
      return;
    }
    if (typeof message.method === "string") {
      for (const handler of [...this.notificationHandlers]) {
        try {
          handler(message.method, (message as { params?: unknown }).params);
        } catch {
          // Faulty subscribers must not break other subscribers.
        }
      }
    }
  }
}
