import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";

import { writeFileAtomic } from "./atomic.js";
import { DATA_DIR as DEFAULT_DATA_DIR, loadConfig } from "./config.js";

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export interface CliOptions {
  command: "setup" | "start" | "serve" | "pair" | "sessions" | "status" | "login" | "logout" | "help";
  port: number;
  dataDir: string;
  label?: string;
  publicUrl?: string;
  domain?: string;
  tailscale: boolean;
  tunnel: boolean;
  client: boolean;
  pair: boolean;
  revoke?: string;
  json: boolean;
  local?: boolean;
  open?: boolean;
  guided?: boolean;
  phone?: "ios" | "android";
}

const COMMANDS = ["setup", "start", "serve", "pair", "sessions", "status", "login", "logout", "help", "--help", "-h"];

export function parseArgs(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions | { error: string } {
  const implicitStart = !argv.length || (argv[0]!.startsWith("--") && argv[0] !== "--help");
  const [command = "start", ...rest] = implicitStart ? ["start", ...argv] : argv;
  if (!COMMANDS.includes(command)) return { error: `unknown command "${command}"` };
  const options: CliOptions = {
    command: command === "--help" || command === "-h" ? "help" : (command as CliOptions["command"]),
    port: Number(env.FINANCE_PORT || env.PORT || 4132),
    dataDir: env.FINANCE_DATA_DIR || env.OMB_DATA_DIR || join(homedir(), ".finance-agent"),
    tailscale: false,
    tunnel: false,
    client: false,
    pair: true,
    json: false,
  };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    const value = () => {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`${arg} needs a value`);
      i += 1; return v;
    };
    try {
      if (arg === "--port") options.port = Number(value());
      else if (arg === "--data-dir") options.dataDir = resolve(value());
      else if (arg === "--label") options.label = value();
      else if (arg === "--public-url") options.publicUrl = value().replace(/\/+$/, "");
      else if (arg === "--domain") options.domain = value();
      else if (arg === "--tunnel") options.tunnel = true;
      else if (arg === "--tailscale") options.tailscale = true;
      else if (arg === "--client") options.client = true;
      else if (arg === "--phone") {
        const kind = value().toLowerCase();
        if (kind !== "ios" && kind !== "android") return { error: "--phone takes ios or android" };
        options.phone = kind as CliOptions["phone"];
      } else if (arg === "--no-pair") options.pair = false;
      else if (arg === "--no-open") options.open = false;
      else if (arg === "--local") options.local = true;
      else if (arg === "--json") options.json = true;
      else if (options.command === "sessions" && arg === "revoke") options.revoke = value();
      else return { error: `unknown argument "${arg}"` };
    } catch (error) { return { error: error instanceof Error ? error.message : String(error) }; }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) return { error: "--port must be 1-65535" };
  if (options.publicUrl && !/^https?:\/\//.test(options.publicUrl)) return { error: "--public-url must start with http:// or https://" };
  if (options.tailscale && options.tunnel) return { error: "choose one of --tailscale and --tunnel" };
  if (options.domain && (options.tailscale || options.tunnel || options.publicUrl)) return { error: "--domain already gives the address; drop --tailscale/--tunnel/--public-url" };
  return options;
}

export const USAGE = `finance-agent — your finance agent OS, ready in one command

  finance-agent                         set up once, then open your workspace
  finance-agent setup [--data-dir DIR]
  finance-agent start [serve options]
  finance-agent serve [--port 4132] [--data-dir DIR] [--label NAME]
                      [--public-url https://host] [--tunnel | --tailscale | --domain HOST] [--no-pair]
  finance-agent pair  [--label NAME] [--client] [--phone ios|android]
  finance-agent sessions [revoke ID]
  finance-agent status [--json]
  finance-agent help

setup   choose execution mode and optional phone access
start   same as finance-agent: use saved settings and open the dashboard
serve   start the server without prompts and print a pairing link + QR code
pair    mint a pairing code against a running server
sessions list paired devices; "sessions revoke ID" signs one out
status  what the server says about itself

--tunnel     public https://….finance-agent.com via Cloudflare (needs login)
--tailscale  serve over your tailnet (needs Tailscale signed in)
--domain     serve at https://HOST via managed Caddy (ports 80/443)
--no-pair    skip phone pairing
--no-open    do not open a browser window
--local      ignore saved remote-access settings this launch
`;

export interface CliIo { log(line: string): void; error(line: string): void; ask(question: string): Promise<string>; }
export function defaultIo(): CliIo {
  return {
    log: (line) => console.log(line),
    error: (line) => console.error(line),
    ask: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try { return await rl.question(question); } finally { rl.close(); }
    },
  };
}

export function serverVersion(here = HERE): string {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(here, "..", "..", "..", "package.json"), "utf8"));
    const version = typeof parsed === "object" && parsed !== null ? Reflect.get(parsed as object, "version") : undefined;
    return typeof version === "string" && version ? version : "0.1.0";
  } catch { return "0.1.0"; }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function api(port: number, path: string, init: { method?: string; body?: string } = {}): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { method: init.method, body: init.body, headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(3000) });
  const body: unknown = await res.json().catch(() => ({}));
  return { status: res.status, body };
}

async function serverUp(port: number, pid?: number): Promise<boolean> {
  try {
    const { status, body } = await api(port, "/api/health");
    const b = body as { status?: string; pid?: number };
    return status === 200 && b?.status === "ok" && (pid === undefined || b.pid === pid);
  } catch { return false; }
}

export async function isWorkspaceRunning(options: CliOptions): Promise<boolean> {
  try {
    const { status, body } = await api(options.port, "/api/health");
    if (status !== 200) return false;
    const b = body as { status?: string };
    if (b?.status !== "ok") return false;
    // environment identity check (finance-agent uses ~/.finance-agent/environment-id)
    try {
      const expected = readFileSync(join(options.dataDir, "environment-id"), "utf8").trim();
      const descriptor = await api(options.port, "/.well-known/finance-agent/environment");
      const d = descriptor.body as { environmentId?: string } | null;
      if (/^[0-9a-f-]{36}$/i.test(expected) && descriptor.status === 200 && d?.environmentId === expected) return true;
      // if descriptor not available, fall back to health check
      return true;
    } catch { return true; }
  } catch { return false; }
}

export async function openDashboard(port: number, env = process.env): Promise<boolean> {
  if (env.SSH_CONNECTION || env.SSH_TTY || (process.platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY)) return false;
  const url = `http://127.0.0.1:${port}`;
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "rundll32.exe" : "xdg-open";
  const args = process.platform === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  return new Promise((done) => {
    const child = spawn(command, args, { stdio: "ignore", windowsHide: true });
    const timer = setTimeout(() => { child.kill(); done(false); }, 3000);
    child.once("error", () => { clearTimeout(timer); done(false); });
    child.once("exit", (code) => { clearTimeout(timer); done(code === 0); });
  });
}

export function normalizePhoneOrigin(origin: string): string | null {
  try { const u = new URL(origin); if (u.protocol !== "https:" && u.protocol !== "http:") return null; return u.origin; } catch { return null; }
}

export async function verifyPhoneEndpoint(port: number, origin: string): Promise<boolean> {
  if (!normalizePhoneOrigin(origin)) return false;
  try {
    const local = await api(port, "/.well-known/finance-agent/environment");
    const remote = await fetch(`${origin}/.well-known/finance-agent/environment`, { signal: AbortSignal.timeout(5000), redirect: "error" });
    if (local.status !== 200 || !remote.ok) return false;
    const descriptor = await remote.json() as { environmentId?: unknown };
    const localBody = local.body as { environmentId?: unknown };
    return typeof localBody?.environmentId === "string" && localBody.environmentId.length > 0 && descriptor.environmentId === localBody.environmentId;
  } catch { return false; }
}

export function qrToString(text: string): string {
  // lightweight QR: return URL if qrcode-terminal not available; try dynamic import
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const qrcode = eval("require")("qrcode-terminal") as { generate: (t: string, opts: unknown, cb: (s: string) => void) => void };
    let out = "";
    qrcode.generate(text, { small: true }, (rendered: string) => { out = rendered; });
    return out || text;
  } catch { return text; }
}

export function pairingBlock(input: { code: string; url: string | null; inviteUrl?: string | null; expiresAt: number; hint?: string | null; phone?: "ios" | "android" }): string {
  const lines = [`pairing code:  ${input.code}`, `expires:       ${new Date(input.expiresAt).toLocaleTimeString()} (single use)`];
  if (!input.url && !input.inviteUrl) {
    lines.push(`open:          /pair on the address you use for this server, and type the code`);
    if (input.hint) lines.push(`               (${input.hint})`);
    return lines.join("\n");
  }
  const scanInvite = input.phone === "android" && !!input.inviteUrl;
  if (input.url) lines.push(scanInvite ? `web browser:   ${input.url}` : `open or scan:  ${input.url}`);
  if (input.inviteUrl) lines.push(`phone app:     ${input.inviteUrl}`);
  const target = scanInvite ? input.inviteUrl! : input.url;
  if (target) {
    lines.push("");
    lines.push(qrToString(target));
    lines.push("");
    if (scanInvite) { lines.push(`Scan that in the app. For browser, open the web address above.`); }
    else if (input.inviteUrl) { lines.push(`Scan with Camera for browser, or paste phone-app link into app.`); }
  }
  return lines.join("\n");
}

function originOf(link: string): string | null { try { return new URL(link).origin; } catch { return null; } }

async function mintPairing(port: number, options: { label?: string; client?: boolean; publicUrl?: string; phone?: "ios" | "android" }): Promise<string> {
  const request: { label?: string; scopes?: string[] } = {};
  if (options.label) request.label = options.label;
  if (options.client) request.scopes = ["client"];
  const { status, body } = await api(port, "/api/auth/pairing", { method: "POST", body: JSON.stringify(request) });
  const b = body as { code?: string; url?: string; credential?: string; inviteUrl?: string; serverName?: string; expiresAt?: number; hint?: string; error?: string };
  if (status !== 200) throw new Error(`server refused to mint pairing code: ${typeof b?.error === "string" ? b.error : status}`);
  const url = options.publicUrl ? `${options.publicUrl}/pair#code=${b.code}` : typeof b.url === "string" ? b.url : null;
  const address = options.publicUrl ?? (typeof b.url === "string" ? originOf(b.url) : null);
  const invite = typeof b.credential === "string" && address ? `finance-agent://pair?address=${encodeURIComponent(address)}&token=${encodeURIComponent(b.credential)}${typeof b.serverName === "string" ? `&name=${encodeURIComponent(b.serverName)}` : ""}` : typeof b.inviteUrl === "string" ? b.inviteUrl : null;
  return pairingBlock({ code: b.code!, url, inviteUrl: invite, expiresAt: b.expiresAt!, hint: typeof b.hint === "string" ? b.hint : null, phone: options.phone });
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
export async function runPair(options: CliOptions): Promise<number> {
  if (!(await serverUp(options.port))) { console.error(`no finance-agent server on http://127.0.0.1:${options.port}; start with \`finance-agent serve\``); return 1; }
  console.log(await mintPairing(options.port, { label: options.label, client: options.client, publicUrl: options.publicUrl, phone: options.phone }));
  if (options.client) console.log("(client scope: chat and approvals only)");
  return 0;
}

export async function runSessions(options: CliOptions): Promise<number> {
  if (!(await serverUp(options.port))) { console.error(`no finance-agent server on http://127.0.0.1:${options.port}`); return 1; }
  if (options.revoke) {
    const { status, body } = await api(options.port, `/api/auth/sessions/${encodeURIComponent(options.revoke)}`, { method: "DELETE" });
    const b = body as { error?: string };
    if (status !== 200) { console.error(`could not revoke: ${typeof b?.error === "string" ? b.error : status}`); return 1; }
    console.log(`revoked ${options.revoke}`);
    return 0;
  }
  const { body } = await api(options.port, "/api/auth/sessions");
  const b = body as { sessions?: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number; expiresAt: number }> };
  const sessions = Array.isArray(b?.sessions) ? b.sessions : [];
  if (options.json) { console.log(JSON.stringify(sessions, null, 2)); return 0; }
  if (!sessions.length) { console.log("no paired devices yet: run `finance-agent pair`"); return 0; }
  console.log(formatSessions(sessions));
  return 0;
}

export function formatSessions(sessions: Array<{ id: string; label: string; scopes: string[]; lastSeenAt: number; expiresAt: number }>, now = Date.now()): string {
  const age = (ms: number) => { const m = Math.max(0, Math.floor((now - ms) / 60_000)); return m < 1 ? "just now" : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
  const rows = sessions.map((s) => [s.id, s.label || "(unnamed)", s.scopes.includes("admin") ? "admin" : "client", age(s.lastSeenAt), new Date(s.expiresAt).toISOString().slice(0, 10)]);
  const head = ["id", "device", "scope", "last seen", "expires"];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ");
  return [line(head), ...rows.map(line), "", "revoke with: finance-agent sessions revoke <id>"].join("\n");
}

export async function runStatus(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  try {
    const res = await fetch(`http://127.0.0.1:${options.port}/api/health`, { signal: AbortSignal.timeout(3000) });
    const body = await res.json() as { status?: string; version?: string; uptime?: number };
    if (!res.ok) throw new Error("not ok");
    io.log(options.json ? JSON.stringify(body, null, 2) : `finance-agent ${body.version ?? serverVersion()} · ${body.status} · up ${Math.round((body.uptime ?? 0))}s on :${options.port}`);
    return 0;
  } catch {
    io.error(`no finance-agent server on http://127.0.0.1:${options.port}`);
    return 1;
  }
}

export function serverEntry(here = HERE): { command: string; args: string[]; staticDir: string | null } {
  const bundled = join(here, "index.js");
  const root = resolve(here, "..");
  if (existsSync(bundled)) {
    const staticDir = [join(root, "..", "..", "apps", "dashboard", "out"), join(root, "dist"), join(here, "..", "dashboard")].find((d) => existsSync(join(d, "index.html"))) ?? null;
    return { command: process.execPath, args: [bundled], staticDir };
  }
  const source = join(here, "index.ts");
  return { command: process.execPath, args: ["--experimental-strip-types", source], staticDir: null };
}

export async function runServe(options: CliOptions, log: (line: string) => void = console.log): Promise<number> {
  if (await serverUp(options.port)) {
    console.error(`something already answers on http://127.0.0.1:${options.port}; use \`finance-agent pair\` or --port for a second server`);
    return 1;
  }
  // domain/tunnel/tailscale are stubs for now — finance version supports --public-url directly
  let publicUrl = options.publicUrl;
  if (options.domain) publicUrl = `https://${options.domain}`;
  if (options.tunnel) log("note: --tunnel not yet configured for finance-agent; using local server");
  if (options.tailscale) log("note: --tailscale not yet configured; using local server");

  const entry = serverEntry();
  const env: NodeJS.ProcessEnv = { ...process.env, FINANCE_DATA_DIR: options.dataDir, FINANCE_PORT: String(options.port), PORT: String(options.port) };
  if (options.label && !process.env.FINANCE_LABEL) env.FINANCE_LABEL = options.label;
  if (publicUrl) env.FINANCE_PUBLIC_URL = publicUrl;

  let child: ChildProcess;
  try {
    child = spawn(entry.command, entry.args, { env, stdio: ["inherit", "inherit", "inherit"] });
  } catch (error) { throw error; }

  let exited: number | null = null;
  const childExit = new Promise<number>((done) => {
    child.once("error", () => { exited = 1; done(1); });
    child.once("exit", (code, signal) => { exited = code ?? (signal === "SIGTERM" || signal === "SIGINT" ? 0 : 1); done(exited); });
  });

  let stopping: Promise<void> | null = null;
  const stop = () => {
    stopping ??= (async () => {
      if (exited === null) { child.kill("SIGTERM"); const timer = setTimeout(() => child.kill("SIGKILL"), 10_000); timer.unref(); await childExit; clearTimeout(timer); }
    })();
    return stopping;
  };
  const onSignal = () => { void stop(); };
  process.on("SIGINT", onSignal); process.on("SIGTERM", onSignal);

  try {
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && exited === null && !stopping) {
      if (await serverUp(options.port, child.pid)) break;
      await new Promise((r) => setTimeout(r, 250));
    }
    if (exited !== null) { log(`server exited with ${exited}`); return exited; }
    if (!(await serverUp(options.port))) { log("server did not become ready in 60s"); await stop(); return 1; }

    log(`\nfinance-agent ready on http://127.0.0.1:${options.port}`);
    if (publicUrl) log(`public url: ${publicUrl}`);
    if (options.pair) {
      try {
        const pairing = await mintPairing(options.port, { label: options.label ?? "finance-agent", publicUrl });
        log("\n" + pairing);
      } catch (error) { log(`pairing not available: ${message(error)}`); }
    }
    if (options.open !== false) {
      const opened = await openDashboard(options.port);
      if (opened) log("opened dashboard in browser");
    }
    log("\nPress Ctrl+C to stop.\n");
    await childExit;
    return exited ?? 0;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    await stop();
  }
}

export async function runSetup(options: CliOptions, io: CliIo = defaultIo()): Promise<number> {
  const cfg = loadConfig(options.dataDir);
  io.log(`\nfinance-agent setup — data dir: ${options.dataDir}\n`);
  const mode = (await io.ask("Execution mode [paper/live] (paper): ")).trim().toLowerCase();
  const executionMode = mode === "live" ? "live" : "paper";
  const symbol = (await io.ask("Default symbol [BTCUSDT]: ")).trim().toUpperCase() || "BTCUSDT";
  const capital = Number((await io.ask("Paper capital [10000]: ")).trim() || "10000");
  const next: typeof cfg = {
    ...cfg,
    executionMode: executionMode as "paper" | "live",
    finance: { defaultSymbol: symbol, paperCapital: Number.isFinite(capital) ? capital : 10000, ...(cfg.finance ?? {}) },
  };
  mkdirSync(options.dataDir, { recursive: true, mode: 0o700 });
  const { saveConfig } = await import("./config.js");
  saveConfig(next, options.dataDir);
  io.log(`\nsaved to ${join(options.dataDir, "config.json")} — run \`finance-agent serve\` to start\n`);
  return 0;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed && typeof parsed === "object" && "error" in parsed) { console.error(parsed.error); console.error(USAGE); return 2; }
  const options = parsed as CliOptions;
  if (options.command === "help") { console.log(USAGE); return 0; }
  if (options.command === "setup") return runSetup(options);
  if (options.command === "serve" || options.command === "start") return runServe(options);
  if (options.command === "pair") return runPair(options);
  if (options.command === "sessions") return runSessions(options);
  if (options.command === "status") return runStatus(options);
  if (options.command === "login" || options.command === "logout") { console.log(`${options.command} not yet implemented for finance-agent (use API keys in config.json)`); return 0; }
  console.error(`unknown command: ${options.command}`); return 2;
}
