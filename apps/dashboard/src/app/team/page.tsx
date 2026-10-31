import { useEffect, useMemo, useState, type FormEvent } from "react";
import {
  Activity, ArrowDownRight, ArrowUpRight, Bot, BrainCircuit, CandlestickChart,
  CheckCircle2, ChevronRight, CircleAlert, Code2, Gauge, LayoutDashboard, LoaderCircle,
  MessageSquare, Play, RefreshCw, ShieldCheck, Sparkles, Terminal, TrendingUp,
  Wallet, Zap,
} from "lucide-react";
import { fetchAgents, fetchHealth, fetchPortfolio, streamAgentChat, fetchWorkflows, startWorkflow, approveWorkflow, rejectWorkflow, fmtCurrency, type AgentApiConfig, type Portfolio, type WorkflowRun } from "../../lib/api";
import "./team.css";

type AgentKey = "quant" | "risk" | "market" | "execution" | "finance";
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
  systemContext: string;
};
type Message = { id: string; role: "user" | "assistant" | "system"; content: string };

const TEAM: TeamAgent[] = [
  { id: "quant", runtimeId: "btc-quant-agent", name: "Quant Analyst", title: "Strategy & signals", description: "Researches setups, tests hypotheses, and explains the evidence behind a strategy.", focus: ["Strategy research", "Signal review", "Backtest ideas"], icon: BrainCircuit, color: "violet", systemContext: "You are the Quant Analyst for a finance agent team. Focus on testable hypotheses, quantitative evidence, entry and exit logic, and explicit invalidation conditions. Never claim a backtest was run unless a tool actually ran it. Do not place orders.", prompt: "Review the current market and propose a testable strategy. State assumptions, entry and exit logic, and what would invalidate it. Do not place orders." },
  { id: "risk", runtimeId: "risk-guardian-agent", name: "Risk Guardian", title: "Exposure & guardrails", description: "Checks downside, concentration, position sizing, and whether a proposed trade fits the risk budget.", focus: ["Exposure checks", "Position sizing", "Drawdown watch"], icon: ShieldCheck, color: "green", systemContext: "You are the Risk Guardian for a finance agent team. Prioritize downside, exposure, concentration, liquidity, drawdown, and position sizing. Challenge weak assumptions and do not place orders.", prompt: "Act as Risk Guardian. Explain the key risks in a paper-trading portfolio and give a concise pre-trade risk checklist. Do not place orders." },
  { id: "market", runtimeId: "market-research-agent", name: "Market Analyst", title: "Research & context", description: "Turns market context into a clear brief with catalysts, scenarios, and uncertainty called out.", focus: ["Market briefings", "Catalysts", "Bull / base / bear"], icon: CandlestickChart, color: "blue", systemContext: "You are the Market Analyst for a finance agent team. Separate verified data from assumptions, state data limitations, and present balanced bull/base/bear scenarios. Do not invent live prices or claim research you did not perform.", prompt: "Write a concise market research briefing. Separate known facts from assumptions, give bull/base/bear scenarios, and identify what data should be checked next." },
  { id: "execution", runtimeId: "cline-cli-agent", name: "Execution Agent", title: "Simulated orders only", description: "Helps prepare and review simulated orders. Live brokerage execution is not enabled in this workspace.", focus: ["Paper orders", "Order review", "Fill tracking"], icon: Zap, color: "amber", systemContext: "You are the Execution Agent for a paper-trading-only finance workspace. Help prepare and review simulated orders, confirm symbol/side/quantity/rationale, and clearly state that you cannot submit or execute orders from this chat. Never use live brokerage execution.", prompt: "Help me prepare a paper-trade order ticket. Ask for any missing symbol, side, quantity, and rationale. Do not submit an order until I explicitly confirm the simulated order." },
  { id: "finance", runtimeId: "finance-lead-agent", name: "Finance Lead", title: "Treasury & allocation", description: "Reviews the paper portfolio as a CFO would — cash, concentration, P&L attribution, and capital allocation.", focus: ["Cash & NAV", "Allocation", "Fee / slippage drag"], icon: Wallet, color: "teal", systemContext: "You are the Finance Lead for a paper-trading-only finance workspace. Focus on treasury, capital allocation, cash vs deployed capital, concentration, NAV and P&L attribution, fees and slippage drag, and fit against the user's stated risk budget. Use portfolio and market tools to read real paper data rather than guessing, show the arithmetic, and separate measured facts from assumptions. You are advisory only: never submit, approve, or execute an order.", prompt: "Review the current paper portfolio as Finance Lead. Show cash vs deployed capital, concentration, P&L and cost drag, then suggest one allocation change with the arithmetic and the risks. Do not place orders." },
];

const QUICK_TASKS = [
  { label: "Draft a strategy", agent: "quant" as AgentKey, prompt: "Suggest one simple, testable crypto strategy and define entry, exit, and invalidation rules. Do not place orders." },
  { label: "Run a risk review", agent: "risk" as AgentKey, prompt: "Give me a pre-trade risk review checklist for a simulated crypto portfolio. Explain sizing, concentration, and stop-loss considerations." },
  { label: "Get a market brief", agent: "market" as AgentKey, prompt: "Prepare a market briefing framework with bull, base, and bear scenarios. Be clear about data limitations and uncertainty." },
  { label: "Review the portfolio", agent: "finance" as AgentKey, prompt: "Review the paper portfolio as Finance Lead: cash vs deployed capital, concentration, P&L and cost drag, then one allocation change with the arithmetic and risks. Do not place orders." },
];

function money(value: number | undefined, currency = "USDT") {
  return fmtCurrency(Number.isFinite(value) ? value ?? 0 : 0, currency);
}

/** Facts the Finance Lead can cite without inventing numbers. Empty when no snapshot is loaded. */
function portfolioBrief(portfolio: Portfolio | null): string {
  if (!portfolio) {
    return "No portfolio snapshot is loaded in this UI session. Call get_portfolio before making any numeric claim.";
  }
  const holdings = portfolio.holdings.length
    ? portfolio.holdings.map((h) => `${h.symbol}: qty=${h.qty}, avg=${h.avgPrice}, mark=${h.price}, value=${h.value}, pnl=${h.pnl}`).join("; ")
    : "none";
  return [
    "Measured paper portfolio snapshot (loaded from the local API):",
    `- totalValue=${portfolio.totalValue} ${portfolio.baseCurrency}`,
    `- availableCash=${portfolio.availableCash} ${portfolio.baseCurrency}`,
    `- pnl: day=${portfolio.pnl.day}, week=${portfolio.pnl.week}, total=${portfolio.pnl.total}, percentDay=${portfolio.pnl.percentDay}`,
    `- risk: exposure=${portfolio.risk.exposure}, maxDrawdown=${portfolio.risk.maxDrawdown}, sharpe=${portfolio.risk.sharpe}, status=${portfolio.risk.status}`,
    `- holdings: ${holdings}`,
  ].join("\n");
}

export default function TeamPage() {
  const [selected, setSelected] = useState<AgentKey>("market");
  const [agents, setAgents] = useState<AgentApiConfig[]>([]);
  const [portfolio, setPortfolio] = useState<Portfolio | null>(null);
  const [serverStatus, setServerStatus] = useState<"checking" | "online" | "offline">("checking");
  const [error, setError] = useState("");
  const [draft, setDraft] = useState("");
  const [messages, setMessages] = useState<Record<AgentKey, Message[]>>({ quant: [], risk: [], market: [], execution: [], finance: [] });
  const [busy, setBusy] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [activity, setActivity] = useState("Ready when you are");
  const [refreshing, setRefreshing] = useState(false);
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [wfBusy, setWfBusy] = useState(false);
  const [wfError, setWfError] = useState("");
  const [rejecting, setRejecting] = useState<string | null>(null);
  const [rejectReason, setRejectReason] = useState("");
  const [wfSymbol, setWfSymbol] = useState("BTCUSDT");

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

  useEffect(() => { void refresh(); void refreshRuns(); }, []);

  async function refreshRuns() {
    try {
      const data = await fetchWorkflows();
      setRuns(data.runs ?? []);
    } catch { /* server offline — the API status pill already says so */ }
  }

  async function runWorkflow() {
    if (wfBusy) return;
    setWfBusy(true);
    setWfError("");
    try {
      await startWorkflow({ symbol: wfSymbol.trim().toUpperCase() });
      await refreshRuns();
      setActivity("Workflow started");
    } catch (err) {
      setWfError(err instanceof Error ? err.message : "Could not start the workflow.");
    } finally { setWfBusy(false); }
  }

  async function approveRun(run: WorkflowRun) {
    if (!run.proposal) return;
    if (!window.confirm(`Deliberately approve this simulated order?\n${run.proposal.side.toUpperCase()} ${run.proposal.quantity} ${run.proposal.symbol} @ ${run.proposal.price} (${run.proposal.type})\nThe server re-checks risk and market freshness before executing the paper order.`)) return;
    setWfBusy(true);
    setWfError("");
    try {
      await approveWorkflow(run.id, { symbol: run.proposal.symbol, side: run.proposal.side, quantity: run.proposal.quantity });
      await refreshRuns();
      void refresh();
    } catch (err) {
      setWfError(err instanceof Error ? err.message : "Approval failed.");
    } finally { setWfBusy(false); }
  }

  async function rejectRun(run: WorkflowRun) {
    const reason = rejectReason.trim();
    if (rejecting !== run.id) { setRejecting(run.id); setRejectReason(""); return; }
    if (!reason) { setWfError("A rejection reason is required."); return; }
    setWfBusy(true);
    setWfError("");
    try {
      await rejectWorkflow(run.id, reason);
      setRejecting(null);
      setRejectReason("");
      await refreshRuns();
    } catch (err) {
      setWfError(err instanceof Error ? err.message : "Rejection failed.");
    } finally { setWfBusy(false); }
  }

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
      const context = activeAgent.id === "finance" ? `${portfolioBrief(portfolio)}\n\n` : "";
      await streamAgentChat(activeAgent.runtimeId, `${activeAgent.systemContext}\n\n${context}User task: ${content}`, (eventData: any) => {
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
        <a className="team-nav-item active" href="#/team"><Sparkles size={17} /> Agent team <span className="team-nav-count">5</span></a>
        <a className="team-nav-item" href="#/home"><LayoutDashboard size={17} /> Workspace home</a>
        <a className="team-nav-item" href="#/engines"><Terminal size={17} /> Model engines <ChevronRight size={14} className="team-nav-chevron" /></a>
        <a className="team-nav-item" href="#/coding"><Code2 size={17} /> Coding agents <ChevronRight size={14} className="team-nav-chevron" /></a>
        <div className="team-divider" />
        <div className="team-workspace-label">YOUR SPECIALISTS <span>05</span></div>
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
              <p className="team-subtitle">Five focused agents. One workspace. You stay in control of every simulated trade.</p>
            </div>
            <button className="team-icon-button" onClick={() => void refresh()} aria-label="Refresh workspace" disabled={refreshing}><RefreshCw size={17} className={refreshing ? "team-spin" : ""} /></button>
          </div>

          {error && <div className="team-error"><CircleAlert size={17} /><span>{error}</span><button onClick={() => setError("")} aria-label="Dismiss error">×</button></div>}

          <div className="team-metrics">
            <div className="team-metric-card"><div className="team-metric-top"><span>Paper equity</span><Wallet size={16} /></div><strong>{portfolio ? money(portfolio.totalValue, portfolio.baseCurrency) : "—"}</strong><small>{portfolio ? "Live from local paper broker" : "Waiting for portfolio API"}</small></div>
            <div className="team-metric-card"><div className="team-metric-top"><span>Available cash</span><ArrowDownRight size={16} /></div><strong>{portfolio ? money(portfolio.availableCash, portfolio.baseCurrency) : "—"}</strong><small>Uncommitted simulated funds</small></div>
            <div className="team-metric-card"><div className="team-metric-top"><span>Total P&L</span>{(portfolio?.pnl.total ?? 0) >= 0 ? <ArrowUpRight size={16} /> : <ArrowDownRight size={16} />}</div><strong className={(portfolio?.pnl.total ?? 0) >= 0 ? "positive" : "negative"}>{portfolio ? money(portfolio.pnl.total, portfolio.baseCurrency) : "—"}</strong><small>{portfolio ? `${portfolio.pnl.percentDay >= 0 ? "+" : ""}${portfolio.pnl.percentDay.toFixed(2)}% reported return` : "Connect the local API to load P&L"}</small></div>
            <div className="team-metric-card"><div className="team-metric-top"><span>Specialists</span><Bot size={16} /></div><strong>05 <span className="team-muted-number">/ 05</span></strong><small>{agents.length ? `${agents.length} runtime agents discovered` : "Team roles ready to configure"}</small></div>
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

          <div className="team-section-heading"><div><h2>Paper trade pipeline</h2><p>Research → proposal → risk review → your approval → simulated execution.</p></div><span className="team-section-meta"><span className="team-live-dot" /> APPROVAL REQUIRED</span></div>
          {wfError && <div className="team-error"><CircleAlert size={17} /><span>{wfError}</span><button onClick={() => setWfError("")} aria-label="Dismiss pipeline error">×</button></div>}
          <div className="team-wf-controls">
            <input className="team-wf-symbol" value={wfSymbol} onChange={(e) => setWfSymbol(e.target.value.toUpperCase())} aria-label="Symbol" spellCheck={false} />
            <button className="team-icon-button" onClick={() => void runWorkflow()} disabled={wfBusy || serverStatus !== "online"} aria-label="Run trade workflow"><Zap size={17} className={wfBusy ? "team-spin" : ""} /> Run trade workflow</button>
          </div>
          <div className="team-wf-runs">
            {runs.length === 0 && <div className="team-wf-empty">No workflow runs yet. Start one above — every run needs your explicit approval before a simulated trade executes.</div>}
            {runs.slice(0, 8).map((run) => (
              <div key={run.id} className={`team-wf-run status-${run.status}`}>
                <div className="team-wf-head">
                  <span className={`team-wf-badge ${run.status}`}>{run.status.replace(/_/g, " ")}</span>
                  {run.proposal && <span className="team-wf-order">{run.proposal.side.toUpperCase()} {run.proposal.quantity} {run.proposal.symbol} @ {run.proposal.price}</span>}
                  <span className="team-wf-time">{new Date(run.updatedAt).toLocaleString()}</span>
                </div>
                {run.proposal && <p className="team-wf-rationale">{run.proposal.rationale}</p>}
                {run.riskReview && <p className="team-wf-risk">Risk Guardian: <strong>{run.riskReview.verdict}</strong>{run.riskReview.concerns.length ? ` — ${run.riskReview.concerns.join("; ")}` : ""}</p>}
                {run.error && <p className="team-wf-error">{run.error}</p>}
                {run.execution && <p className="team-wf-fill">{run.execution.success ? "Paper order executed" : `Rejected at '${run.execution.stage}'`} — {run.execution.reason}{run.execution.filledPrice ? ` · fill ${run.execution.filledPrice}` : ""}</p>}
                {run.portfolioAfter?.equity !== undefined && <p className="team-wf-portfolio">Portfolio after: equity {money(run.portfolioAfter.equity)}</p>}
                {run.status === "awaiting_approval" && run.proposal && (
                  <div className="team-wf-actions">
                    <button onClick={() => void approveRun(run)} disabled={wfBusy} title="Approve the exact recorded order parameters">Approve &amp; submit paper order</button>
                    <button onClick={() => void rejectRun(run)} disabled={wfBusy}>{rejecting === run.id ? "Use the reason box →" : "Reject"}</button>
                  </div>
                )}
                {rejecting === run.id && run.status === "awaiting_approval" && (
                  <div className="team-wf-reject-row">
                    <input value={rejectReason} onChange={(e) => setRejectReason(e.target.value)} placeholder="Why are you rejecting this proposal? (required, audited)" maxLength={200} />
                    <button onClick={() => void rejectRun(run)} disabled={wfBusy || !rejectReason.trim()}>Save rejection</button>
                    <button onClick={() => { setRejecting(null); setRejectReason(""); }}>Cancel</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          <footer className="team-footer"><span><span className="team-live-dot" /> {activity}</span><span>FINANCE AGENT OS <span className="team-footer-sep">/</span> DESKTOP WORKSPACE</span></footer>
        </section>
      </main>
    </div>
  );
}
