import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity, ArrowDownRight, ArrowUpRight, Bot, BrainCircuit, CandlestickChart,
  CheckCircle2, ChevronRight, CircleAlert, Gauge, LayoutDashboard, LoaderCircle,
  MessageSquare, Play, RefreshCw, ShieldCheck, Sparkles, Terminal, TrendingUp,
  Wallet, Zap,
} from "lucide-react";
import { fetchAgents, fetchHealth, fetchPortfolio, streamAgentChat, fmtCurrency, type AgentApiConfig, type Portfolio } from "../../lib/api";
import "./team.css";

type AgentKey = "quant" | "risk" | "market" | "execution";
type TeamAgent = {
  id: AgentKey;
  runtimeId: string;
  name: string;
  title: string;
  description: string;
  focus: string[];
  icon: typeof BrainCircuit;
  color: string;
  prompt: string;
};
type Message = { id: string; role: "user" | "assistant" | "system"; content: string };

const TEAM: TeamAgent[] = [
  { id: "quant", runtimeId: "btc-quant-agent", name: "Quant Analyst", title: "Strategy & signals", description: "Researches setups, tests hypotheses, and explains the evidence behind a strategy.", focus: ["Strategy research", "Signal review", "Backtest ideas"], icon: BrainCircuit, color: "violet", prompt: "Review the current market and propose a testable strategy. State assumptions, entry and exit logic, and what would invalidate it. Do not place orders." },
  { id: "risk", runtimeId: "risk-guardian-agent", name: "Risk Guardian", title: "Exposure & guardrails", description: "Checks downside, concentration, position sizing, and whether a proposed trade fits the risk budget.", focus: ["Exposure checks", "Position sizing", "Drawdown watch"], icon: ShieldCheck, color: "green", prompt: "Act as Risk Guardian. Explain the key risks in a paper-trading portfolio and give a concise pre-trade risk checklist. Do not place orders." },
  { id: "market", runtimeId: "market-research-agent", name: "Market Analyst", title: "Research & context", description: "Turns market context into a clear brief with catalysts, scenarios, and uncertainty called out.", focus: ["Market briefings", "Catalysts", "Bull / base / bear"], icon: CandlestickChart, color: "blue", prompt: "Write a concise market research briefing. Separate known facts from assumptions, give bull/base/bear scenarios, and identify what data should be checked next." },
  { id: "execution", runtimeId: "cline-cli-agent", name: "Execution Agent", title: "Simulated orders only", description: "Helps prepare and review simulated orders. Live brokerage execution is not enabled in this workspace.", focus: ["Paper orders", "Order review", "Fill tracking"], icon: Zap, color: "amber", prompt: "Help me prepare a paper-trade order ticket. Ask for any missing symbol, side, quantity, and rationale. Do not submit an order until I explicitly confirm the simulated order." },
];

const QUICK_TASKS = [
  { label: "Draft a strategy", agent: "quant" as AgentKey, prompt: "Suggest one simple, testable crypto strategy and define entry, exit, and invalidation rules. Do not place orders." },
  { label: "Run a risk review", agent: "risk" as AgentKey, prompt: "Give me a pre-trade risk review checklist for a simulated crypto portfolio. Explain sizing, concentration, and stop-loss considerations." },
  { label: "Get a market brief", agent: "market" as AgentKey, prompt: "Prepare a market briefing framework with bull, base, and bear scenarios. Be clear about data limitations and uncertainty." },
];

function money(value: number | undefined, currency = "USDT") {
  return fmtCurrency(Number.isFinite(value) ? value ?? 0 : 0, currency);
}

export default function TeamPage() {
  const [selected, setSelected] = useState<AgentKey>("market");
  const [agents, setAgents] = useState<AgentApiConfig[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [serverStatus, setServerStatus] = useState<"checking" | "online" | "offline">("checking");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Record<AgentKey, Message[]>>({ quant: [], risk: [], market: [], execution: [] });
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [activity, setActivity] = useState("Ready when you are");
  const [refreshing, setRefreshing] = useState(false);

  const activeAgent = TEAM.find((agent) => agent.id === selected) ?? TEAM[0];
  const runtimeAgent = agents.find((agent) => agent.id === activeAgent.runtimeId);
  const activeMessages = messages[selected];
  const agentStatus = (id: AgentKey) => {
    const runtimeId = TEAM.find((item) => item.id === id)?.runtimeId;
    const agent = agents.find((item) => item.id === runtimeId);
    return agent ? "Configured" : serverStatus === "online" ? "Awaiting runtime" : "Offline";
  };

  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      const [health, runtime, pf] = await Promise.allSettled([fetchHealth(), fetchAgents(), fetchPortfolio()]);
      if (health.status === "fulfilled") setServerStatus("online");
      else setServerStatus("offline");
      if (runtime.status === "fulfilled") setAgents(runtime.value.agents ?? []);
      if (pf.status === "fulfilled") setPortfolio(pf.value);
      if (health.status === "rejected" && runtime.status === "rejected") {
        setError("Could not reach the local Finance Agent API. Start the server, then retry.");
      } else if (pf.status === "rejected") {
        setPortfolio(null);
      }
    } finally {
      setRefreshing(false);
    }
  }

  useEffect(() => { void refresh(); }, []);

  async function submitMessage(event?: FormEvent, override?: string) {
    event?.preventDefault();
    const content = (override ?? draft).trim();
    if (!content || busy) return;
    setDraft("");
    setError("");
    const userMessage: Message = { id: `user-${Date.now()}`, role: "user", content };
    setMessages((current) => ({ ...current, [selected]: [...current[selected], userMessage] }));
    setBusy(true);
    setStreamText("");
    setActivity(`${activeAgent.name} is working`);
    let accumulated = "";
    try {
      await streamAgentChat(activeAgent.runtimeId, content, (eventData: any) => {
        const type = String(eventData?.type ?? "").toLowerCase();
        const piece = [eventData?.delta, eventData?.text, eventData?.token, eventData?.content]
          .find((value) => typeof value === "string" && value.length > 0);
        if (typeof piece === "string" && (type.includes("token") || type.includes("delta") || type.includes("chunk") || type.includes("text") || type.includes("message"))) {
          accumulated += piece;
          setStreamText(accumulated);
        }
        if (type.includes("tool")) setActivity("Using a finance tool");
        if (type.includes("error")) {
          const message = typeof eventData?.error === "string" ? eventData.error : "Agent reported an error.";
          setError(message);
        }
      });
      const finalContent = accumulated.trim() || "The agent run completed without returning streamed text. Check the server logs or configure a model for this agent.";
      setMessages((current) => ({ ...current, [selected]: [...current[selected], { id: `assistant-${Date.now()}`, role: "assistant", content: finalContent }] }));
      setActivity("Run complete");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Agent request failed.";
      setError(message);
      setActivity("Run failed");
    } finally {
      setBusy(false);
      setStreamText("");
    }
  }

  const initials = useMemo(() => activeAgent.name.split(" ").map((word) => word[0]).join("").slice(0, 2), [activeAgent.name]);
  const Icon = activeAgent.icon;

  return (
    <div className="team-shell">
      <aside className="team-sidebar">
        <a className="team-brand" href="#/team">
          <span className="team-brand-mark"><Activity size={19} /></span>
          <span><strong>FINANCE OS</strong><small>AGENT WORKSPACE</small></span>
        </a>
        <div className="team-workspace-label">WORKSPACE</div>
        <a className="team-nav-item active" href="#/team"><Sparkles size={17} /> Agent team <span className="team-nav-count">4</span></a>
        <a className="team-nav-item" href="#/dashboard"><LayoutDashboard size={17} /> Overview</a>
        <a className="team-nav-item" href="#/engines"><Terminal size={17} /> Model engines <ChevronRight size={14} className="team-nav-chevron" /></a>
        <div className="team-divider" />
        <div className="team-workspace-label">YOUR SPECIALISTS <span>04</span></div>
        <div className="team-agent-list">
          {TEAM.map((agent) => {
            const AgentIcon = agent.icon;
            return <button key={agent.id} className={`team-agent-link ${selected === agent.id ? "selected" : ""}`} onClick={() => { setSelected(agent.id); setError(""); setActivity("Ready when you are"); }}>
              <span className={`team-agent-avatar ${agent.color}`}><AgentIcon size={17} /></span>
              <span className="team-agent-link-copy"><strong>{agent.name}</strong><small>{agent.title}</small></span>
              <span className={`team-status-dot ${agentStatus(agent.id) === "Configured" ? "good" : ""}`} />
            </button>;
          })}
        </div>
        <div className="team-sidebar-bottom">
          <div className="team-paper-badge"><span className="team-live-dot" /><span><strong>Paper trading</strong><small>Simulated orders only</small></span></div>
          <button className="team-nav-item team-refresh" onClick={() => void refresh()} disabled={refreshing}><RefreshCw size={16} className={refreshing ? "team-spin" : ""} /> Refresh connections</button>
        </div>
      </aside>

      <main className="team-main">
        <header className="team-topbar">
          <div className="team-breadcrumb">Workspace <span>/</span> <strong>Agent team</strong></div>
          <div className="team-topbar-right">
            <span className={`team-connection ${serverStatus}`}><span className="team-status-dot" /> {serverStatus === "online" ? "API connected" : serverStatus === "offline" ? "API offline" : "Connecting…"}</span>
            <span className="team-mode-pill"><ShieldCheck size={13} /> PAPER MODE</span>
          </div>
        </header>

        <section className="team-content">
          <div className="team-heading-row">
            <div>
              <div className="team-eyebrow"><span className="team-eyebrow-line" /> YOUR AI DESK</div>
              <h1>Your finance team, <span>in sync.</span></h1>
              <p className="team-subtitle">Four focused agents. One workspace. You stay in control of every simulated trade.</p>
            </div>
            <button className="team-icon-button" onClick={() => void refresh()} aria-label="Refresh workspace" disabled={refreshing}><RefreshCw size={17} className={refreshing ? "team-spin" : ""} /></button>
          </div>

          {error && <div className="team-error"><CircleAlert size={17} /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}

          <div className="team-metrics">
            <div className="team-metric-card"><div className="team-metric-top"><span>Paper equity</span><Wallet size={16} /></div><strong>{portfolio ? money(portfolio.totalValue, portfolio.baseCurrency) : "—"}</strong><small>{portfolio ? "Live from local paper broker" : "Waiting for portfolio API"}</small></div>
            <div className="team-metric-card"><div className="team-metric-top"><span>Available cash</span><ArrowDownRight size={16} /></div><strong>{portfolio ? money(portfolio.availableCash, portfolio.baseCurrency) : "—"}</strong><small>Uncommitted simulated funds</small></div>
            <div className="team-metric-card"><div className="team-metric-top"><span>Total P&L</span>{(portfolio?.pnl.total ?? 0) >= 0 ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}</div><strong className={(portfolio?.pnl.total ?? 0) >= 0 ? "positive" : "negative"}>{portfolio ? money(portfolio.pnl.total, portfolio.baseCurrency) : "—"}</strong><small>{portfolio ? `${portfolio.pnl.percentDay >= 0 ? "+" : ""}${portfolio.pnl.percentDay.toFixed(2)}% reported return` : "Connect the local API to load P&L"}</small></div>
            <div className="team-metric-card"><div className="team-metric-top"><span>Specialists</span><Bot size={16} /></div><strong>04 <span className="team-muted-number">/ 04</span></strong><small>{agents.length ? `${agents.length} runtime agents discovered` : "Team roles ready to configure"}</small></div>
          </div>

          <div className="team-section-heading"><div><h2>Meet your specialists</h2><p>Choose an agent to give it a task.</p></div><span className="team-section-meta"><span className="team-live-dot" /> LOCAL WORKSPACE</span></div>
          <div className="team-cards">
            {TEAM.map((agent, index) => {
              const AgentIcon = agent.icon;
              const isSelected = selected === agent.id;
              return <button key={agent.id} className={`team-card ${isSelected ? "chosen" : ""}`} onClick={() => { setSelected(agent.id); setError(""); setActivity("Ready when you are"); }}>
                <div className="team-card-top"><span className={`team-card-icon ${agent.color}`}><AgentIcon size={19} /></span><span className="team-card-index">0{index + 1}</span></div>
                <div className="team-card-name">{agent.name}</div><div className="team-card-title">{agent.title}</div>
                <p>{agent.description}</p>
                <div className="team-chip-row">{agent.focus.map((focus) => <span key={focus}>{focus}</span>)}</div>
                <div className="team-card-footer"><span className={`team-agent-state ${agentStatus(agent.id) === "Configured" ? "ready" : ""}`}><span className="team-status-dot" /> {agentStatus(agent.id)}</span><span className="team-open-agent">{isSelected ? "Selected" : "Open"} <ChevronRight size={14} /></span></div>
              </button>;
            })}
          </div>

          <div className="team-workbench">
            <div className="team-chat-panel">
              <div className="team-chat-header">
                <div className={`team-card-icon ${activeAgent.color}`}><Icon size={19} /></div>
                <div className="team-chat-agent-title"><strong>Chat with {activeAgent.name}</strong><span>{activeAgent.title} · {runtimeAgent?.model || "Uses configured agent engine"}</span></div>
                <span className="team-session-tag"><span className="team-live-dot" /> PRIVATE SESSION</span>
              </div>
              <div className="team-chat-body">
                {activeMessages.length === 0 && !busy ? <div className="team-empty-state">
                  <div className={`team-empty-icon ${activeAgent.color}`}><Icon size={25} /></div>
                  <h3>What should {activeAgent.name.split(" ")[0]} work on?</h3>
                  <p>{activeAgent.description} Start with a suggested task or write your own brief.</p>
                  <button className="team-suggested-prompt" onClick={() => void submitMessage(undefined, activeAgent.prompt)}><Sparkles size={15} /><span><strong>Start a {activeAgent.title.toLowerCase()} task</strong><small>{activeAgent.prompt}</small></span><ChevronRight size={15} /></button>
                </div> : <div className="team-message-list">
                  {activeMessages.map((message) => <div key={message.id} className={`team-message ${message.role}`}><div className="team-message-avatar">{message.role === "user" ? "YOU" : initials}</div><div className="team-message-content"><span className="team-message-role">{message.role === "user" ? "You" : activeAgent.name}</span><p>{message.content}</p></div></div>)}
                  {busy && <div className="team-message assistant"><div className="team-message-avatar">{initials}</div><div className="team-message-content"><span className="team-message-role">{activeAgent.name} · working</span><p>{streamText || activity}<span className="team-cursor" /></p></div></div>}
                </div>}
              </div>
              <form className="team-composer" onSubmit={(event) => void submitMessage(event)}>
                <textarea value={draft} onChange={(event) => setDraft(event.target.value)} placeholder={`Give ${activeAgent.name} a task…`} rows={2} disabled={busy} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void submitMessage(); } }} />
                <div className="team-composer-footer"><span><Sparkles size={13} /> Review outputs before acting · Enter to send</span><button type="submit" disabled={busy || !draft.trim()}>{busy ? <LoaderCircle size={16} className="team-spin" /> : <Play size={15} fill="currentColor" />} Run agent</button></div>
              </form>
            </div>
            <aside className="team-context-panel">
              <div className="team-context-title"><Gauge size={16} /><strong>Workspace context</strong></div>
              <div className="team-context-block"><span className="team-context-label">EXECUTION MODE</span><div className="team-context-value"><ShieldCheck size={16} /> Simulated only</div><p>Orders are paper trades. No live brokerage credentials or real-money execution are used by this workspace.</p></div>
              <div className="team-context-block"><span className="team-context-label">RUNTIME STATUS</span><div className="team-runtime-row"><span>Finance API</span><strong className={serverStatus === "online" ? "positive" : serverStatus === "offline" ? "negative" : ""}>{serverStatus === "online" ? "Connected" : serverStatus === "offline" ? "Offline" : "Checking"}</strong></div><div className="team-runtime-row"><span>Agent runtime</span><strong>{agents.length ? `${agents.length} loaded` : "Not detected"}</strong></div><div className="team-runtime-row"><span>Active specialist</span><strong>{activeAgent.name}</strong></div></div>
              <div className="team-context-block"><span className="team-context-label">QUICK TASKS</span>{QUICK_TASKS.map((task) => <button key={task.label} className="team-quick-task" onClick={() => { setSelected(task.agent); setDraft(task.prompt); setError(""); }}><span>{task.label}</span><ChevronRight size={14} /></button>)}</div>
              <div className="team-context-note"><CheckCircle2 size={16} /><p><strong>You are the decision-maker.</strong> Use agents for analysis and preparation. Review outputs and risk checks before approving any simulated order.</p></div>
            </aside>
          </div>

          <footer className="team-footer"><span><span className="team-live-dot" /> {activity}</span><span>FINANCE AGENT OS <span className="team-footer-sep">/</span> DESKTOP WORKSPACE</span></footer>
        </section>
      </main>
    </div>
  );
}
