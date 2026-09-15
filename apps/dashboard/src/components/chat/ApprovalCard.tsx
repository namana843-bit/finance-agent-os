"use client";

import type { TradeProposal } from "@/lib/chat-api";

type ApprovalCardProps = {
  proposal: TradeProposal;
  onApprove: (id: string) => void;
  onReject: (id: string) => void;
  busy: boolean;
};

const SIDE_STYLES: Record<string, string> = {
  buy: "bg-emerald-500/15 text-emerald-400 border-emerald-500/30",
  sell: "bg-red-500/15 text-red-400 border-red-500/30",
};

export function ApprovalCard({
  proposal,
  onApprove,
  onReject,
  busy,
}: ApprovalCardProps) {
  const side = proposal.side.toLowerCase();
  const isBuy = side === "buy";
  const status = proposal.status.toLowerCase();

  const isPending = status === "pending";
  const isApproved = status === "approved";
  const isTerminalDim =
    status === "rejected" || status === "expired" || status === "failed";

  return (
    <div className="card p-4 border border-white/10 rounded-xl bg-black/30">
      <div className="flex items-center gap-2 flex-wrap">
        <span
          className={`text-[11px] font-bold px-2 py-0.5 rounded-md border ${
            SIDE_STYLES[side] ??
            "bg-white/10 text-white/70 border-white/20"
          }`}
        >
          {isBuy ? "BUY" : side === "sell" ? "SELL" : proposal.side.toUpperCase()}
        </span>
        <span className="text-sm font-bold tracking-tight">
          {proposal.symbol}
        </span>
        <span className="text-xs opacity-60">
          qty {proposal.quantity}
          {proposal.price !== undefined && proposal.price !== null
            ? ` @ ${proposal.price}`
            : ""}
        </span>
        <span className="ml-auto text-[11px] uppercase tracking-wide opacity-50">
          {proposal.status}
        </span>
      </div>

      {proposal.reason && (
        <p className="mt-2 text-xs opacity-70 leading-relaxed break-words">
          {proposal.reason}
        </p>
      )}

      {isPending && (
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => onApprove(proposal.id)}
            className="flex-1 text-xs py-2 rounded-xl bg-violet-600 hover:bg-violet-500 font-semibold disabled:opacity-40"
          >
            {busy ? "Working…" : "Approve"}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onReject(proposal.id)}
            className="flex-1 text-xs py-2 rounded-xl bg-white/5 hover:bg-white/10 border border-white/10 font-semibold disabled:opacity-40"
          >
            Reject
          </button>
        </div>
      )}

      {isApproved && (
        <div className="mt-3 flex items-start gap-2 text-xs text-emerald-400 border border-emerald-500/20 bg-emerald-500/10 rounded-lg px-2 py-1.5 break-words">
          <span aria-hidden>✓</span>
          <span>
            Approved
            {proposal.result ? ` — ${proposal.result}` : ""}
          </span>
        </div>
      )}

      {isTerminalDim && (
        <div className="mt-3 text-xs opacity-40 break-words">
          {proposal.status}
          {proposal.result ? ` — ${proposal.result}` : ""}
        </div>
      )}
    </div>
  );
}
