import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleSlash,
  Code2,
  FolderGit2,
  FolderOpen,
  GitBranch,
  LayoutDashboard,
  LoaderCircle,
  Plug,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  Terminal,
  Wrench,
  XCircle,
} from "lucide-react";
import {
  addProject,
  cancelSession,
  createSession,
  describeError,
  fetchProjects,
  fetchProjectDiff,
  fetchProviders,
  fetchSession,
  fetchSessions,
  refreshProvider,
  removeProject,
  removeSessionWorktree,
  streamTurn,
  type CodingProject,
  type CodingProjectDiff,
  type CodingProvider,
  type CodingSession,
  type CodingTurn,
} from "../../lib/coding-api";
import "./coding.css";

type Message = { id: string; role: "user" | "assistant"; content: string; cancelled?: boolean };

const MESSAGE_LIMIT = 400;

function timeAgo(timestamp: number): string {
  const seconds = Math.max(1, Math.floor((Date.now() - timestamp) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function turnsToMessages(turns: CodingTurn[]): Message[] {
  return turns
    .filter((turn) => turn.role === "user" || turn.role === "assistant")
    .slice(-MESSAGE_LIMIT)
    .map((turn) => ({
      id: turn.id,
      role: turn.role as "user" | "assistant",
      content: turn.content,
      ...(turn.cancelled ? { cancelled: true } : {}),
    }));
}

function capabilityLabel(id: string): string {
  return id.replace(/_/g, " ");
}

export default function CodingPage() {
  const [providers, setProviders] = useState<CodingProvider[]>([]);
  const [projects, setProjects] = useState<CodingProject[]>([]);
  const [sessions, setSessions] = useState<CodingSession[]>([]);
  const [providerId, setProviderId] = useState<string>("");
  const [projectId, setProjectId] = useState<string>("");
  const [sessionId, setSessionId] = useState<string>("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamText, setStreamText] = useState("");
  const [toolLog, setToolLog] = useState<string[]>([]);
  const [terminalLog, setTerminalLog] = useState<string[]>([]);
  const [diff, setDiff] = useState<CodingProjectDiff | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [showPatch, setShowPatch] = useState(false);
  const [isolate, setIsolate] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [newPath, setNewPath] = useState("");
  const [addingProject, setAddingProject] = useState(false);
  const [serverStatus, setServerStatus] = useState<"checking" | "online" | "offline">("checking");
  const abortRef = useRef<AbortController | null>(null);

  const activeProvider = useMemo(
    () => providers.find((provider) => provider.providerId === providerId),
    [providers, providerId],
  );
  const activeProject = useMemo(
    () => projects.find((project) => project.id === projectId),
    [projects, projectId],
  );
  const activeSession = useMemo(
    () => sessions.find((session) => session.id === sessionId),
    [sessions, sessionId],
  );

  const refreshAll = useCallback(async () => {
    setError("");
    try {
      const [nextProviders, nextProjects] = await Promise.all([fetchProviders(), fetchProjects()]);
      setProviders(nextProviders);
      setProjects(nextProjects);
      setServerStatus("online");
      setProviderId((current) => current || nextProviders.find((provider) => provider.status.installed)?.providerId || nextProviders[0]?.providerId || "");
      setProjectId((current) => current || nextProjects[0]?.id || "");
    } catch (err) {
      setServerStatus("offline");
      setError(describeError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refreshAll();
  }, [refreshAll]);

  const loadSessions = useCallback(async (filter: { providerId?: string; projectId?: string }) => {
    try {
      const next = await fetchSessions(filter);
      setSessions(next);
      return next;
    } catch (err) {
      setError(describeError(err));
      return [];
    }
  }, []);

  useEffect(() => {
    if (!providerId) {
      setSessions([]);
      return;
    }
    void loadSessions(projectId ? { providerId, projectId } : { providerId });
  }, [providerId, projectId, loadSessions]);

  const openSession = useCallback(async (id: string) => {
    if (!id) {
      setSessionId("");
      setMessages([]);
      setToolLog([]);
      setTerminalLog([]);
      return;
    }
    try {
      const session = await fetchSession(id);
      setSessionId(session.id);
      setMessages(turnsToMessages(session.turns));
      const events = session.turns.flatMap((turn) => turn.events ?? []);
      setToolLog(
        events
          .filter((event) => event.type === "tool" && event.name)
          .map((event) => `tool · ${event.name} ${JSON.stringify(event.arguments ?? {})}`)
          .slice(-200),
      );
      setTerminalLog(
        events
          .filter((event) => event.type === "terminal" && event.chunk)
          .map((event) => `${event.stream ?? "stdout"} · ${(event.chunk ?? "").trimEnd()}`)
          .filter((line) => line.length > 0)
          .slice(-200),
      );
      setError("");
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  const ensureSession = useCallback(async (): Promise<CodingSession | null> => {
    if (activeSession && activeSession.status !== "closed") return activeSession;
    if (!providerId || !projectId) {
      setError("Choose a provider and a project first.");
      return null;
    }
    try {
      const session = await createSession({ providerId, projectId, ...(isolate ? { isolate: true } : {}) });
      setIsolate(false);
      setSessionId(session.id);
      setMessages([]);
      setToolLog([]);
      setTerminalLog([]);
      await loadSessions({ providerId, projectId });
      return session;
    } catch (err) {
      setError(describeError(err));
      return null;
    }
  }, [activeSession, providerId, projectId, loadSessions, isolate]);

  const loadDiff = useCallback(async (id: string) => {
    if (!id) {
      setDiff(null);
      return;
    }
    setDiffLoading(true);
    try {
      setDiff(await fetchProjectDiff(id));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setDiffLoading(false);
    }
  }, []);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || busy) return;
    const session = await ensureSession();
    if (!session) return;

    setDraft("");
    setError("");
    setBusy(true);
    setStreamText("");
    setMessages((current) => [...current, { id: `local-${Date.now()}`, role: "user", content: text }]);

    const controller = new AbortController();
    abortRef.current = controller;
    let accumulated = "";

    try {
      await streamTurn(
        session.id,
        text,
        (event) => {
          if (event.type === "text" && event.content) {
            accumulated += event.content;
            setStreamText(accumulated);
          } else if (event.type === "tool" && event.name) {
            setToolLog((current) => [...current, `tool · ${event.name} ${JSON.stringify(event.arguments ?? {})}`].slice(-200));
          } else if (event.type === "terminal" && event.chunk) {
            const line = `${event.stream ?? "stdout"} · ${event.chunk.trimEnd()}`;
            if (line.trim().length > 0) {
              setTerminalLog((current) => [...current, line].slice(-200));
            }
          } else if (event.type === "error" && event.message) {
            setError(event.message);
          } else if (event.type === "turn_complete") {
            const turn = event as unknown as { content?: string; cancelled?: boolean };
            if (turn.content && accumulated.length === 0) accumulated = turn.content;
            if (turn.cancelled) accumulated = `${accumulated}\n\n[cancelled]`.trim();
          }
        },
        controller.signal,
      );
      const finalText = accumulated.trim() || "The provider finished without returning text. Check the terminal output for details.";
      setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", content: finalText }]);
      void loadSessions({ providerId, projectId });
      if (projectId) void loadDiff(projectId);
    } catch (err) {
      if (controller.signal.aborted) {
        setMessages((current) => [
          ...current,
          { id: `assistant-${Date.now()}`, role: "assistant", content: accumulated || "Turn cancelled.", cancelled: true },
        ]);
      } else {
        setError(describeError(err));
        if (accumulated.trim()) {
          setMessages((current) => [...current, { id: `assistant-${Date.now()}`, role: "assistant", content: accumulated }]);
        }
      }
    } finally {
      abortRef.current = null;
      setBusy(false);
      setStreamText("");
    }
  }, [draft, busy, ensureSession, loadSessions, loadDiff, providerId, projectId]);

  const cancel = useCallback(async () => {
    abortRef.current?.abort();
    if (sessionId) {
      try {
        await cancelSession(sessionId);
      } catch (err) {
        setError(describeError(err));
      }
    }
  }, [sessionId]);

  const dropWorktree = useCallback(async (id: string) => {
    const ok = window.confirm(
      "Remove this session's worktree? Any uncommitted changes the agent made there are discarded.",
    );
    if (!ok) return;
    try {
      const updated = await removeSessionWorktree(id, true);
      setSessions((current) => current.map((entry) => (entry.id === id ? updated : entry)));
      setError("");
    } catch (err) {
      setError(describeError(err));
    }
  }, []);
  const submitProject = useCallback(async () => {
    const path = newPath.trim();
    if (!path) return;
    setAddingProject(true);
    setError("");
    try {
      const project = await addProject(path);
      setProjects((current) => {
        const next = current.filter((entry) => entry.id !== project.id);
        return [project, ...next];
      });
      setProjectId(project.id);
      setNewPath("");
    } catch (err) {
      // Path errors carry a machine-readable code — show the server's message.
      setError(describeError(err));
    } finally {
      setAddingProject(false);
    }
  }, [newPath]);

  const dropProject = useCallback(async (id: string) => {
    setError("");
    try {
      await removeProject(id);
      setProjects((current) => current.filter((project) => project.id !== id));
      if (projectId === id) setProjectId("");
    } catch (err) {
      setError(describeError(err));
    }
  }, [projectId]);

  const refreshOne = useCallback(async (id: string) => {
    try {
      const provider = await refreshProvider(id);
      setProviders((current) => current.map((entry) => (entry.providerId === id ? provider : entry)));
    } catch (err) {
      setError(describeError(err));
    }
  }, []);

  useEffect(() => {
    setShowPatch(false);
    if (projectId) void loadDiff(projectId);
    else setDiff(null);
  }, [projectId, loadDiff]);

  const connection = activeProvider
    ? activeProvider.status.installed
      ? { label: "Installed", tone: "good" as const }
      : { label: "Not installed", tone: "bad" as const }
    : { label: "No provider", tone: "muted" as const };

  return (
    <div className="team-shell coding-shell">
      <aside className="team-sidebar">
        <a className="team-brand" href="#/team">
          <span className="team-brand-mark"><Activity size={19} /></span>
          <span><strong>FINANCE OS</strong><small>AGENT WORKSPACE</small></span>
        </a>
        <div className="team-workspace-label">WORKSPACE</div>
        <a className="team-nav-item" href="#/team"><Sparkles size={17} /> Agent team <span className="team-nav-count">4</span></a>
        <a className="team-nav-item" href="#/home"><LayoutDashboard size={17} /> Workspace home</a>
        <a className="team-nav-item" href="#/engines"><Terminal size={17} /> Model engines</a>
        <a className="team-nav-item active" href="#/coding"><Code2 size={17} /> Coding agents</a>
        <div className="team-divider" />

        <div className="team-workspace-label">PROJECTS <span>{String(projects.length).padStart(2, "0")}</span></div>
        <div className="team-agent-list">
          {projects.length === 0 && <p className="coding-hint">Add a project folder to begin.</p>}
          {projects.map((project) => (
            <div key={project.id} className={`coding-project-row ${project.id === projectId ? "selected" : ""}`}>
              <button className="coding-project-button" onClick={() => { setProjectId(project.id); setSessionId(""); setMessages([]); setToolLog([]);
      setTerminalLog([]); }}>
                <span className="coding-project-icon">{project.git?.isRepo ? <FolderGit2 size={15} /> : <FolderOpen size={15} />}</span>
                <span className="coding-project-copy">
                  <strong>{project.name}</strong>
                  <small>{project.git?.isRepo ? project.git.branch || "git repo" : "folder"}</small>
                </span>
                {project.git?.dirty && <span className="coding-dirty-dot" title="uncommitted changes" />}
              </button>
              <button className="coding-project-remove" title="Remove project" onClick={() => void dropProject(project.id)}><XCircle size={13} /></button>
            </div>
          ))}
        </div>
        <div className="coding-add-project">
          <input
            value={newPath}
            onChange={(event) => setNewPath(event.target.value)}
            onKeyDown={(event) => { if (event.key === "Enter") void submitProject(); }}
            placeholder="C:\path\to\project"
            aria-label="Project path"
          />
          <button onClick={() => void submitProject()} disabled={addingProject || newPath.trim().length === 0} title="Add project">
            {addingProject ? <LoaderCircle size={14} className="coding-spin" /> : <Plus size={14} />}
          </button>
        </div>

        <div className="team-divider" />
        <div className="team-workspace-label">SESSIONS <span>{String(sessions.length).padStart(2, "0")}</span></div>
        <div className="coding-session-list">
          {sessions.length === 0 && <p className="coding-hint">No sessions for this provider yet.</p>}
          {sessions.map((session) => (
            <button
              key={session.id}
              className={`coding-session-row ${session.id === sessionId ? "selected" : ""}`}
              onClick={() => void openSession(session.id)}
            >
              <span className={`coding-session-dot status-${session.status}`} />
              <span className="coding-session-copy">
                <strong>{session.title}</strong>
                <small>{session.status} · {timeAgo(session.updatedAt)}</small>
              </span>
            </button>
          ))}
        </div>

        <div className="team-sidebar-bottom">
          <div className="team-paper-badge"><span className="team-live-dot" /><span><strong>Project-scoped</strong><small>Runs in the selected folder</small></span></div>
          <button className="team-nav-item team-refresh" onClick={() => void refreshAll()}><RefreshCw size={16} /> Refresh discovery</button>
        </div>
      </aside>

      <main className="team-main">
        <header className="team-topbar">
          <div className="team-breadcrumb">Workspace <span>/</span> <strong>Coding agents</strong></div>
          <div className="team-topbar-right">
            <span className={`team-connection ${serverStatus}`}><span className="team-status-dot" /> {serverStatus === "online" ? "API connected" : serverStatus === "offline" ? "API offline" : "Connecting…"}</span>
            <span className={`coding-connection-pill ${connection.tone}`}><Plug size={13} /> {connection.label}</span>
          </div>
        </header>

        <div className="team-content coding-content">
          <div className="team-heading-row">
            <div>
              <div className="team-eyebrow"><span className="team-eyebrow-line" /> CODING WORKSPACE</div>
              <h1>Run your coding agents <span>side by side</span></h1>
              <p className="team-subtitle">Each provider keeps its own session and project context. Nothing is merged.</p>
            </div>
            <button className="team-icon-button" onClick={() => void refreshAll()} title="Refresh"><RefreshCw size={15} /></button>
          </div>

          {error && (
            <div className="team-error">
              <AlertTriangle size={14} />
              <span>{error}</span>
              <button onClick={() => setError("")} aria-label="Dismiss">×</button>
            </div>
          )}

          <div className="coding-provider-grid">
            {loading && <div className="coding-empty">Probing installed coding agents…</div>}
            {!loading && providers.length === 0 && <div className="coding-empty">No coding providers are registered on this server.</div>}
            {providers.map((provider) => {
              const selected = provider.providerId === providerId;
              return (
                <button
                  key={provider.providerId}
                  className={`coding-provider-card ${selected ? "chosen" : ""}`}
                  onClick={() => { setProviderId(provider.providerId); setSessionId(""); setMessages([]); setToolLog([]);
      setTerminalLog([]); }}
                >
                  <div className="coding-provider-top">
                    <span className="coding-provider-name">{provider.name}</span>
                    <span className={`coding-provider-state ${provider.status.installed ? "good" : "bad"}`}>
                      {provider.status.installed ? <CheckCircle2 size={12} /> : <CircleSlash size={12} />}
                      {provider.status.installed ? "installed" : "missing"}
                    </span>
                  </div>
                  <p>{provider.description}</p>
                  <div className="coding-provider-meta">
                    <span>{provider.status.version ? `v${provider.status.version}` : "version unknown"}</span>
                    <span>auth: {provider.status.auth}</span>
                  </div>
                  {!provider.status.installed && provider.installHint && (
                    <p className="coding-provider-hint">{provider.installHint}</p>
                  )}
                  <div className="coding-provider-actions">
                    <span>{Object.values(provider.capabilities).filter((capability) => capability.supported).length} capabilities</span>
                    <span
                      className="coding-provider-refresh"
                      role="button"
                      tabIndex={0}
                      onClick={(event) => { event.stopPropagation(); void refreshOne(provider.providerId); }}
                      onKeyDown={(event) => { if (event.key === "Enter") { event.stopPropagation(); void refreshOne(provider.providerId); } }}
                    >
                      <RefreshCw size={11} /> re-probe
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          <div className="coding-workbench">
            <section className="team-chat-panel">
              <header className="team-chat-header">
                <span className="coding-agent-badge"><Code2 size={16} /></span>
                <div className="team-chat-agent-title">
                  <strong>{activeProvider?.name ?? "Select a provider"}</strong>
                  <span>{activeProject ? activeProject.path : "No project selected"}</span>
                </div>
                <span className="team-session-tag">
                  <span className="team-live-dot" />
                  {activeSession ? `${activeSession.status} · ${activeSession.id}` : "new session"}
                </span>
              </header>

              <div className="team-chat-body">
                {messages.length === 0 && !busy && (
                  <div className="team-empty-state">
                    <div className="team-empty-icon green"><Code2 size={22} /></div>
                    <h3>Start a coding session</h3>
                    <p>
                      {activeProvider && !activeProvider.status.installed
                        ? `${activeProvider.name} is not installed. Install it, then re-probe.`
                        : activeProject
                          ? `Ask ${activeProvider?.name ?? "the agent"} to change something in ${activeProject.name}.`
                          : "Add a project folder in the sidebar first."}
                    </p>
                  </div>
                )}
                <div className="team-message-list">
                  {messages.map((message) => (
                    <div key={message.id} className={`team-message ${message.role}`}>
                      <span className="team-message-avatar">{message.role === "user" ? "YOU" : "AI"}</span>
                      <div className="team-message-content">
                        <div className="team-message-role">{message.role === "user" ? "You" : activeProvider?.name ?? "Agent"}</div>
                        <p>{message.content || (message.cancelled ? "Cancelled." : "…")}</p>
                      </div>
                    </div>
                  ))}
                  {busy && (
                    <div className="team-message assistant">
                      <span className="team-message-avatar">AI</span>
                      <div className="team-message-content">
                        <div className="team-message-role">{activeProvider?.name ?? "Agent"} · running</div>
                        <p>{streamText || "Working…"}<span className="team-cursor" /></p>
                      </div>
                    </div>
                  )}
                </div>
              </div>

              <div className="team-composer">
                <textarea
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      void send();
                    }
                  }}
                  placeholder={activeProject ? `Ask ${activeProvider?.name ?? "the agent"} to do something in ${activeProject.name}…` : "Add a project first"}
                  disabled={!activeProject || !activeProvider?.status.installed}
                />
                <div className="team-composer-footer">
                  <span><Wrench size={11} /> {activeSession?.model ?? "provider default model"}</span>
                  <label className="coding-isolate-toggle" title="Run the next new session in its own git worktree">
                    <input
                      type="checkbox"
                      checked={isolate}
                      onChange={(event) => setIsolate(event.target.checked)}
                      disabled={busy}
                    />
                    <GitBranch size={11} /> isolated worktree
                  </label>
                  {busy ? (
                    <button onClick={() => void cancel()} className="coding-cancel-button"><Square size={11} /> Cancel</button>
                  ) : (
                    <button onClick={() => void send()} disabled={!draft.trim() || !activeProject || !activeProvider?.status.installed}>
                      <Send size={12} /> Run turn
                    </button>
                  )}
                </div>
              </div>
            </section>

            <aside className="team-context-panel">
              <div className="team-context-title"><Terminal size={14} /> Session context</div>

              <div className="team-context-block">
                <div className="team-context-label">PROVIDER</div>
                <div className="team-runtime-row"><span>Name</span><strong>{activeProvider?.name ?? "—"}</strong></div>
                <div className="team-runtime-row"><span>Executable</span><strong>{activeProvider?.executable ?? "—"}</strong></div>
                <div className="team-runtime-row"><span>Version</span><strong>{activeProvider?.status.version ?? "unknown"}</strong></div>
                <div className="team-runtime-row"><span>Auth</span><strong>{activeProvider?.status.auth ?? "unknown"}</strong></div>
              </div>

              {activeProvider?.status.auth === "unauthenticated" && activeProvider.authHint && (
                <div className="team-context-note coding-note-warn">
                  <AlertTriangle size={13} />
                  <p><strong>Sign-in needed.</strong> {activeProvider.authHint}</p>
                </div>
              )}

              <div className="team-context-block">
                <div className="team-context-label">PROJECT</div>
                <div className="team-runtime-row"><span>Path</span><strong className="coding-path">{activeProject?.path ?? "—"}</strong></div>
                <div className="team-runtime-row"><span>Git</span><strong>{activeProject?.git?.isRepo ? `${activeProject.git.branch ?? "repo"}${activeProject.git.dirty ? " · dirty" : ""}` : "not a repo"}</strong></div>
                <div className="team-runtime-row"><span>Session</span><strong>{activeSession?.id ?? "—"}</strong></div>
                {activeSession?.worktreePath && (
                  <>
                    <div className="team-runtime-row"><span>Worktree</span><strong className="coding-path">{activeSession.worktreePath}</strong></div>
                    <div className="team-runtime-row"><span>Branch</span><strong>{activeSession.worktreeBranch ?? "—"}</strong></div>
                    <button className="coding-worktree-remove" onClick={() => void dropWorktree(activeSession.id)}>
                      <GitBranch size={11} /> Remove worktree
                    </button>
                  </>
                )}
              </div>

              <div className="team-context-block">
                <div className="team-context-label">
                  CHANGES
                  <button
                    className="coding-diff-refresh"
                    onClick={() => activeProject && void loadDiff(activeProject.id)}
                    disabled={!activeProject || diffLoading}
                    title="Refresh changes"
                  >
                    {diffLoading ? <LoaderCircle size={10} className="coding-spin" /> : <RefreshCw size={10} />}
                  </button>
                </div>
                {!diff && <p className="coding-hint">Select a project to review its working tree.</p>}
                {diff && !diff.isRepo && <p className="coding-hint">Not a git repository — no diff to review.</p>}
                {diff && diff.isRepo && (
                  <>
                    <div className="team-runtime-row"><span>Changed</span><strong>{diff.files.length} file(s)</strong></div>
                    <div className="coding-diff-files">
                      {diff.files.length === 0
                        ? <span className="coding-hint">Working tree clean.</span>
                        : diff.files.map((file) => (
                            <div key={`${file.status}-${file.path}`} className="coding-diff-file">
                              <span className={`coding-diff-status s-${file.status.replace(/\?/g, "u")}`}>{file.status}</span>
                              <span title={file.path}>{file.path}</span>
                            </div>
                          ))}
                    </div>
                    {diff.patch.trim().length > 0 && (
                      <button className="coding-diff-toggle" onClick={() => setShowPatch((current) => !current)}>
                        {showPatch ? "Hide patch" : "Review patch"}
                      </button>
                    )}
                    {showPatch && diff.patch.trim().length > 0 && (
                      <pre className="coding-diff-patch">{diff.patch}</pre>
                    )}
                    {diff.truncated && <p className="coding-hint">Patch truncated for display.</p>}
                    {diff.error && <p className="coding-hint">{diff.error}</p>}
                  </>
                )}
              </div>

              <div className="team-context-block">
                <div className="team-context-label">CAPABILITIES</div>
                <div className="coding-capability-list">
                  {activeProvider
                    ? Object.entries(activeProvider.capabilities).map(([id, capability]) => (
                        <div key={id} className={`coding-capability ${capability.supported ? "on" : "off"}`} title={capability.supported ? "supported" : capability.reason}>
                          <span>{capability.supported ? <CheckCircle2 size={11} /> : <CircleSlash size={11} />}</span>
                          <span>{capabilityLabel(id)}</span>
                        </div>
                      ))
                    : <p className="coding-hint">Select a provider.</p>}
                </div>
              </div>

              <div className="team-context-block">
                <div className="team-context-label">TERMINAL OUTPUT</div>
                <div className="coding-terminal">
                  {toolLog.length === 0 && terminalLog.length === 0
                    ? <span className="coding-terminal-empty">No tool activity yet.</span>
                    : [...toolLog.map((line) => ({ tone: "tool", line })), ...terminalLog.map((line) => ({ tone: "term", line }))]
                        .map((entry, index) => (
                          <div key={`${index}-${entry.line.slice(0, 18)}`} className={entry.tone === "term" ? "coding-terminal-line" : ""}>{entry.line}</div>
                        ))}
                </div>
              </div>

              <div className="team-context-note">
                <ChevronRight size={13} />
                <p><strong>Isolation.</strong> Switching provider or project opens a separate session. History from another agent never appears here.</p>
              </div>
            </aside>
          </div>
        </div>
      </main>
    </div>
  );
}
