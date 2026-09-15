import { createHash } from "node:crypto";
import { DATA_DIR, type AppConfig } from "./config.js";
import { loadEnvironmentId } from "./config.js";

const shellQuote = (value: string): string => `'${value.replace(/'/g, "'\\''")}'`;

export const MAX_REMOTE_COMMAND_LENGTH = 4_000;

export function isolatedRemoteCommand(command: string): string {
  return [
    "exec env -i",
    'HOME="$HOME"',
    'USER="${USER:-$(id -un)}"',
    'LOGNAME="${LOGNAME:-${USER:-$(id -un)}}"',
    'PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"',
    'DISPLAY="${DISPLAY:-:0}"',
    'XAUTHORITY="${XAUTHORITY:-$HOME/.Xauthority}"',
    'XDG_RUNTIME_DIR="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}"',
    'DBUS_SESSION_BUS_ADDRESS="${DBUS_SESSION_BUS_ADDRESS:-}"',
    "/bin/bash -c",
    shellQuote(command),
  ].join(" ");
}

const BOX_API = process.env.FINANCE_BOX_API || process.env.OMB_BOX_API || "https://ascii.dev/api/box/v1";
const READY = new Set(["idle", "ready", "running"]);
const SLEEPING = new Set(["archived", "archiving", "stopped", "stopping"]);

let scopedBoxPrefixCache: string | null = null;

function scopedBoxPrefix(): string {
  if (scopedBoxPrefixCache) return scopedBoxPrefixCache;
  const scope = createHash("sha256").update(loadEnvironmentId(DATA_DIR)).digest("hex").slice(0, 12);
  scopedBoxPrefixCache = `fng-${scope}-`;
  return scopedBoxPrefixCache;
}

export interface ManagedBoxOwner { botId: string; name: string; inUse: boolean; }
export interface ManagedBoxInventoryInstance { boxId: string; name: string; state: string; ownerBotId: string | null; ownerName: string | null; orphaned: boolean; inUse: boolean; }
export interface ManagedBoxInventory { configured: boolean; available: boolean; problem: string | null; instances: ManagedBoxInventoryInstance[]; }
export type BoxTurnLifecycleAction = "attach" | "provision" | "wake" | "none";

export function boxTurnLifecycleAction({ explicitCloud, canMount, state }: { explicitCloud: boolean; canMount: boolean; state: string | null; }): BoxTurnLifecycleAction {
  if (!canMount) return "none";
  if (state && READY.has(state)) return "attach";
  if (!explicitCloud) return "none";
  return state ? "wake" : "provision";
}

function snapshotBoxConfig(cfg: AppConfig): AppConfig { return { box: cfg.box ? { token: cfg.box.token } : undefined }; }
function boxFetch(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  return fetch(`${BOX_API}${path}`, { ...opts, headers: { authorization: `Bearer ${cfg.box?.token}`, "content-type": "application/json", ...opts.headers } });
}
async function boxJson(cfg: AppConfig, path: string, opts: RequestInit = {}) {
  const res = await boxFetch(cfg, path, opts);
  const body: unknown = await res.json().catch(() => null);
  return { ok: res.ok && (body as { ok?: boolean })?.ok !== false, status: res.status, body: body as Record<string, unknown> | null };
}

function boxBotNameParts(botId: string): { prefix: string; hash: string } {
  const prefix = botId.slice(0, 8).toLowerCase().replace(/[^a-z0-9]/g, "") || "bot";
  const hash = createHash("sha256").update(botId).digest("hex").slice(0, 6);
  return { prefix, hash };
}
export async function boxNameFor(botId: string): Promise<string> {
  const { prefix, hash } = boxBotNameParts(botId);
  return `${scopedBoxPrefix()}${prefix}-${hash}`;
}
export function boxConfigured(cfg: AppConfig): boolean { return Boolean(cfg.box?.token); }

export async function verifyToken(token: string): Promise<{ ok: true } | { ok: false; message: string }> {
  try {
    const res = await fetch(`${BOX_API}/boxes`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(20_000) });
    if (res.ok) return { ok: true };
    if (res.status === 401 || res.status === 403) return { ok: false, message: token.startsWith("box_") ? "ascii.dev rejected that token — it may have been revoked." : "That doesn't look like a box API key (starts with box_)." };
    return { ok: false, message: `ascii.dev returned ${res.status} — try again.` };
  } catch { return { ok: false, message: "Couldn't reach ascii.dev to check that token." }; }
}

export function boxErrorMessage(status: number, what: string, body?: unknown): string {
  const theirs = typeof (body as { message?: unknown })?.message === "string" ? String((body as { message: string }).message).trim() : "";
  if (status === 402) return theirs || "ascii.dev needs a paid Box plan.";
  if (status === 401 || status === 403) return "box token rejected — update it in config.json (starts with box_)";
  if (status === 429) return theirs || "ascii.dev is rate-limiting — wait a minute";
  return theirs ? `${what} failed: ${theirs}` : `${what} failed (${status})`;
}

async function waitReady(cfg: AppConfig, boxId: string, budgetMs = 90_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < budgetMs) {
    const { body } = await boxJson(cfg, `/boxes/${boxId}`);
    const state = (body as { box?: { state?: string } })?.box?.state;
    if (state && READY.has(state)) return (body as { box: unknown }).box as { id: string; state: string };
    if (state === "error") return null;
    if (state === "archived") await boxJson(cfg, `/boxes/${boxId}/resume`, { method: "POST" });
    await new Promise((r) => setTimeout(r, 2500));
  }
  return null;
}

const boxIdCache = new Map<string, string>();

export async function findBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  const cachedId = boxIdCache.get(botId);
  if (cachedId) {
    try {
      const direct = await boxJson(cfg, `/boxes/${cachedId}`);
      const directBox = (direct.body as { box?: { id?: string; state?: string } })?.box;
      if (direct.ok && directBox?.id === cachedId && directBox.state !== "error") return directBox;
      if (direct.ok && directBox?.id !== cachedId) throw Object.assign(new Error("invalid box identity"), { status: 503 });
    } catch { /* fall through */ }
    boxIdCache.delete(botId);
  }
  const name = await boxNameFor(botId);
  let listed: Awaited<ReturnType<typeof boxJson>>;
  try { listed = await boxJson(cfg, `/boxes?limit=200`, { signal: AbortSignal.timeout(20_000) }); } catch { throw Object.assign(new Error("Could not reach ascii.dev"), { status: 503 }); }
  if (!listed.ok || !Array.isArray((listed.body as { boxes?: unknown[] })?.boxes)) throw Object.assign(new Error(boxErrorMessage(listed.status, "list boxes", listed.body)), { status: listed.status });
  const boxes = (listed.body as { boxes: Array<{ id: string; name: string; state: string }> }).boxes;
  const found = boxes.find((b) => b.name === name && b.state !== "error") ?? null;
  if (found) boxIdCache.set(botId, found.id);
  return found;
}

export async function provisionBox(cfg: AppConfig, botId: string, _botName: string) {
  cfg = snapshotBoxConfig(cfg);
  if (!boxConfigured(cfg)) throw new Error('box not enabled — add {"box":{"token":"box_…"}} to ~/.finance-agent/config.json');
  const vmName = await boxNameFor(botId);
  let box = await findBox(cfg, botId) as { id: string; state: string } | null;
  let created = false;
  if (!box) {
    const createRes = await boxJson(cfg, "/boxes", { method: "POST", body: JSON.stringify({ ttlSeconds: 8 * 60 * 60, noEnv: true }), signal: AbortSignal.timeout(45_000) });
    if (!createRes.ok || !(createRes.body as { box?: { id?: string } })?.box?.id) throw new Error(boxErrorMessage(createRes.status, "box create", createRes.body));
    box = (createRes.body as { box: { id: string; state: string } }).box;
    const rename = await boxJson(cfg, `/boxes/${box.id}`, { method: "PATCH", body: JSON.stringify({ name: vmName }) });
    if (!rename.ok) throw new Error(boxErrorMessage(rename.status, "box naming", rename.body));
    created = true;
  }
  const ready = await waitReady(cfg, box.id);
  if (!ready) throw new Error("box did not become ready within 90s — retry");
  const desktopRes = await boxJson(cfg, `/boxes/${box.id}/desktop?vnc=1`, { method: "POST" });
  const joinUrl = (desktopRes.body as { desktopUrl?: string; url?: string })?.desktopUrl ?? (desktopRes.body as { url?: string })?.url ?? null;
  return { boxId: box.id, machineName: vmName, reused: !created, state: (ready as { state: string }).state, joinUrl };
}

export async function joinBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  const box = await findBox(cfg, botId) as { id: string; state: string } | null;
  if (!box) throw new Error("no box yet — provision first");
  const ready = await waitReady(cfg, box.id);
  if (!ready) throw new Error("box did not wake");
  const desktopRes = await boxJson(cfg, `/boxes/${box.id}/desktop?vnc=1`, { method: "POST" });
  const joinUrl = (desktopRes.body as { desktopUrl?: string; url?: string })?.desktopUrl ?? null;
  return { joinUrl, state: (ready as { state: string }).state ?? null };
}

export async function sleepBox(cfg: AppConfig, botId: string) {
  cfg = snapshotBoxConfig(cfg);
  const box = await findBox(cfg, botId) as { id: string } | null;
  if (!box) throw new Error("no box for this bot");
  const stopped = await boxJson(cfg, `/boxes/${box.id}/stop`, { method: "POST" });
  if (!stopped.ok) throw Object.assign(new Error(boxErrorMessage(stopped.status, "box sleep", stopped.body)), { status: stopped.status });
  for (const [k, v] of boxIdCache) if (v === box.id) boxIdCache.delete(k);
  return { ok: true };
}

export async function execOnBox(cfg: AppConfig, botId: string, command: string) {
  cfg = snapshotBoxConfig(cfg);
  if (command.length > MAX_REMOTE_COMMAND_LENGTH) throw new RangeError(`command too long (max ${MAX_REMOTE_COMMAND_LENGTH})`);
  const box = await findBox(cfg, botId) as { id: string; state: string } | null;
  if (!box) throw new Error("no box for this bot yet");
  const ready = await waitReady(cfg, box.id, 60_000);
  if (!ready) throw new Error("box did not wake");
  const res = await boxFetch(cfg, `/boxes/${box.id}/commands`, { method: "POST", body: JSON.stringify({ command: isolatedRemoteCommand(command) }), signal: AbortSignal.timeout(120_000) });
  const body: unknown = await res.json().catch(() => null) as { exitCode?: number; stdout?: string; stderr?: string };
  return { exitCode: (body as { exitCode?: number })?.exitCode ?? null, stdout: String((body as { stdout?: string })?.stdout ?? "").slice(-4000), stderr: String((body as { stderr?: string })?.stderr ?? "").slice(-2000) };
}

export const PANEL_FRAME_WIDTH = 1920;
export const PANEL_FRAME_QUALITY = 85;
const PANEL_PATH = "/tmp/finance-panel.jpg";
const PANEL_FRAME_FFMPEG_Q = 3;
export function panelShotCommand({ width = PANEL_FRAME_WIDTH, quality = PANEL_FRAME_QUALITY } = {}): string {
  return [
    "export DISPLAY=${DISPLAY:-:0}",
    `f=${PANEL_PATH}`,
    'rm -f "$f"',
    'w=$(xdotool getdisplaygeometry 2>/dev/null | cut -d" " -f1)',
    'case "$w" in ""|*[!0-9]*) w=0;; esac',
    `scrot -o -p -q ${quality} "$f" 2>/dev/null || import -window root -quality ${quality} "$f" 2>/dev/null || ffmpeg -y -f x11grab -draw_mouse 1 -i "$DISPLAY" -frames:v 1 -q:v ${PANEL_FRAME_FFMPEG_Q} "$f" >/dev/null 2>&1`,
    `if [ "$w" -gt ${width} ] 2>/dev/null && command -v convert >/dev/null 2>&1; then convert "$f" -resize ${width}x -quality ${quality} "$f" 2>/dev/null || true; fi`,
    'test -s "$f" && echo captured',
  ].join("; ");
}

async function readFileBase64(cfg: AppConfig, boxId: string, path: string): Promise<string | null> {
  try {
    const res = await boxFetch(cfg, `/boxes/${boxId}/artifacts?path=${encodeURIComponent(path)}`);
    if (res.ok) { const bytes = Buffer.from(await res.arrayBuffer()); if (bytes.length) return bytes.toString("base64"); }
  } catch { /* fall through */ }
  const { ok, body } = await boxJson(cfg, `/boxes/${boxId}/files?path=${encodeURIComponent(path)}&encoding=base64`);
  const content = (body as { content?: string })?.content;
  return ok && typeof content === "string" && content ? content : null;
}

export async function screenshotBox(cfg: AppConfig, botId: string, knownBoxId?: string) {
  cfg = snapshotBoxConfig(cfg);
  let boxId = knownBoxId;
  if (!boxId) {
    const box = await findBox(cfg, botId) as { id: string; state: string } | null;
    if (!box) throw new Error("no box for this bot yet");
    if (!READY.has(box.state)) throw new Error(`box is ${box.state}`);
    boxId = box.id;
  }
  const shotCmd = panelShotCommand();
  const res = await boxFetch(cfg, `/boxes/${boxId}/commands`, { method: "POST", body: JSON.stringify({ command: shotCmd }), signal: AbortSignal.timeout(60_000) });
  const body = await res.json().catch(() => null) as { stdout?: string; stderr?: string };
  if (!/captured/.test(String(body?.stdout ?? ""))) throw new Error(String(body?.stderr ?? "").slice(0, 200) || "screen capture failed");
  const data = await readFileBase64(cfg, boxId, PANEL_PATH);
  if (!data) throw new Error("could not read frame");
  return { png: data, format: "jpeg" };
}
