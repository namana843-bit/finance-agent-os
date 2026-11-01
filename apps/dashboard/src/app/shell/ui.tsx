import type { ReactNode } from "react";
import { AlertTriangle, ArrowRight, Loader2, RefreshCw } from "lucide-react";
import { cn } from "../../lib/utils";

export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-4 pb-6">
      <div className="min-w-0">
        {eyebrow ? (
          <div className="mb-2 flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.18em] text-emerald-400/80">
            <span className="h-px w-5 bg-emerald-500/50" />
            {eyebrow}
          </div>
        ) : null}
        <h1 className="text-[26px] font-semibold tracking-tight text-neutral-50">{title}</h1>
        {description ? (
          <p className="mt-1.5 max-w-2xl text-[12.5px] leading-relaxed text-neutral-500">{description}</p>
        ) : null}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Panel({
  children,
  className,
  as: Tag = "div",
}: {
  children: ReactNode;
  className?: string;
  as?: "div" | "section" | "article";
}) {
  return (
    <Tag className={cn("rounded-xl border border-white/[0.07] bg-white/[0.02] backdrop-blur-sm", className)}>
      {children}
    </Tag>
  );
}

export function SectionHeading({
  title,
  description,
  meta,
  action,
}: {
  title: string;
  description?: string;
  meta?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h2 className="text-[13.5px] font-semibold text-neutral-100">{title}</h2>
        {description ? <p className="mt-0.5 text-[11.5px] text-neutral-500">{description}</p> : null}
      </div>
      <div className="flex items-center gap-2">
        {meta ? <span className="font-mono text-[10px] uppercase tracking-wider text-neutral-600">{meta}</span> : null}
        {action}
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = "default",
  loading,
  unavailable,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: ReactNode;
  tone?: "default" | "good" | "warn";
  loading?: boolean;
  unavailable?: boolean;
}) {
  const toneRing =
    tone === "good" ? "text-emerald-300" : tone === "warn" ? "text-amber-300" : "text-neutral-200";
  return (
    <Panel className="p-4">
      <div className="flex items-center justify-between text-[11px] text-neutral-500">
        <span>{label}</span>
        <span className={cn("opacity-70", toneRing)}>{icon}</span>
      </div>
      <div className={cn("mt-3 font-semibold tracking-tight", toneRing, "text-[26px] leading-none")}>
        {loading ? (
          <span className="inline-block h-6 w-12 animate-pulse rounded bg-white/10" />
        ) : unavailable ? (
          <span className="text-[15px] font-medium text-neutral-500">Unavailable</span>
        ) : (
          value
        )}
      </div>
      {hint ? <div className="mt-2 truncate text-[10.5px] text-neutral-600">{hint}</div> : null}
    </Panel>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
  compact,
}: {
  icon?: ReactNode;
  title: string;
  description: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.015] text-center",
        compact ? "px-4 py-7" : "px-6 py-12",
      )}
    >
      {icon ? (
        <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.03] text-neutral-400">
          {icon}
        </div>
      ) : null}
      <div className="text-[13px] font-medium text-neutral-200">{title}</div>
      <p className="mt-1.5 max-w-sm text-[11.5px] leading-relaxed text-neutral-500">{description}</p>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function ErrorBanner({
  title = "Something went wrong",
  message,
  onRetry,
}: {
  title?: string;
  message: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-xl border border-rose-500/25 bg-rose-500/[0.06] px-4 py-3">
      <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
      <div className="min-w-0 flex-1">
        <div className="text-[12px] font-medium text-rose-200">{title}</div>
        <div className="mt-0.5 break-words text-[11px] text-rose-300/70">{message}</div>
      </div>
      {onRetry ? (
        <button
          type="button"
          onClick={onRetry}
          className="flex items-center gap-1.5 rounded-md border border-rose-400/30 px-2.5 py-1.5 text-[11px] font-medium text-rose-200 transition-colors hover:bg-rose-500/10"
        >
          <RefreshCw className="h-3 w-3" />
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function LoadingBlock({ label = "Loading", rows = 3 }: { label?: string; rows?: number }) {
  return (
    <div className="space-y-2" aria-busy="true" aria-label={label}>
      {Array.from({ length: rows }).map((_, index) => (
        <div
          key={index}
          className="h-16 animate-pulse rounded-xl border border-white/[0.05] bg-white/[0.02]"
          style={{ opacity: 1 - index * 0.15 }}
        />
      ))}
    </div>
  );
}

export function InlineSpinner({ className }: { className?: string }) {
  return <Loader2 className={cn("h-3.5 w-3.5 animate-spin", className)} />;
}

export function StatusPill({
  label,
  className,
  dotClassName,
}: {
  label: string;
  className?: string;
  dotClassName?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[10px] font-medium",
        className ?? "border-white/10 bg-white/5 text-neutral-300",
      )}
    >
      <span className={cn("h-1.5 w-1.5 rounded-full", dotClassName ?? "bg-neutral-400")} />
      {label}
    </span>
  );
}

export function TextButton({
  children,
  onClick,
  className,
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md border border-white/10 bg-white/[0.03] px-2.5 py-1.5 text-[11.5px] font-medium text-neutral-200 transition-colors hover:border-white/20 hover:bg-white/[0.06] disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-md bg-emerald-500 px-3 py-1.5 text-[11.5px] font-semibold text-emerald-950 transition-colors hover:bg-emerald-400 disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function GhostLink({ children, onClick }: { children: ReactNode; onClick?: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group inline-flex items-center gap-1 text-[11.5px] font-medium text-emerald-400 transition-colors hover:text-emerald-300"
    >
      {children}
      <ArrowRight className="h-3 w-3 transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}

export function MonoLabel({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("font-mono text-[9.5px] uppercase tracking-[0.14em] text-neutral-600", className)}>
      {children}
    </div>
  );
}
