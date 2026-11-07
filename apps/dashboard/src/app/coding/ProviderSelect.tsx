import { useEffect, useState } from "react";
import { ChevronDown, CheckCircle2, CircleSlash, LoaderCircle, Plug } from "lucide-react";
import {
  refreshProvider,
  type CodingProvider,
} from "../../lib/coding-api";

interface ProviderSelectProps {
  /** Providers fetched from the backend provider registry. */
  providers: CodingProvider[];
  /** Currently connected provider id, if any. */
  value: string;
  /** Connect to a provider: selects it and re-probes installation. */
  onConnect: (providerId: string) => Promise<void>;
  /** Switch provider without re-probing (onConnect handles the probe). */
  onChange: (providerId: string) => void;
  /** Fetch fresh providers from the backend. */
  onRefresh?: () => void;
  disabled?: boolean;
}

/**
 * Dynamic provider dropdown. Options come from the backend
 * (`GET /api/coding/providers`), not from any hard-coded list, so the UI
 * always mirrors what the server discovered. Connecting means selecting the
 * provider for new sessions and re-probing its installation status.
 */
export function ProviderSelect({
  providers,
  value,
  onConnect,
  onChange,
  onRefresh,
  disabled = false,
}: ProviderSelectProps) {
  const [open, setOpen] = useState(false);
  const [connecting, setConnecting] = useState(false);

  // Close on Escape or outside click.
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement;
      if (!target.closest(".coding-provider-select")) setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onClick);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onClick);
    };
  }, [open]);

  const active = providers.find((provider) => provider.providerId === value) ?? null;

  const connect = async (providerId: string) => {
    setOpen(false);
    if (providerId === value) return;
    setConnecting(true);
    try {
      onChange(providerId);
      await onConnect(providerId);
      const updated = await refreshProvider(providerId);
      // surface fresh install status via callback-less local state is handled
      // by the parent through its own providers state; re-probe result is
      // delivered through refreshProvider's return to keep this component dumb.
      void updated;
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div className="coding-provider-select">
      <button
        type="button"
        className={`coding-provider-select-button ${active ? "connected" : ""}`}
        onClick={() => setOpen((current) => !current)}
        disabled={disabled || connecting}
        title={active ? `${active.name} — ${active.status.installed ? "installed" : "not installed"}` : "Choose a provider"}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <Plug size={13} />
        <span className="coding-provider-select-label">
          {connecting ? "Connecting…" : active ? active.name : "Connect a provider"}
        </span>
        {active && (
          <span className={`coding-provider-state ${active.status.installed ? "good" : "bad"}`}>
            {active.status.installed ? <CheckCircle2 size={11} /> : <CircleSlash size={11} />}
          </span>
        )}
        {connecting ? (
          <LoaderCircle size={12} className="coding-spin" />
        ) : (
          <ChevronDown size={12} className={open ? "open" : ""} />
        )}
      </button>

      {open && (
        <div className="coding-provider-select-menu" role="listbox" aria-label="Available providers">
          {onRefresh && (
            <button
              type="button"
              className="coding-provider-select-refresh"
              onClick={(event) => {
                event.stopPropagation();
                onRefresh();
              }}
            >
              <Plug size={11} /> Re-scan backend for providers
            </button>
          )}
          {providers.length === 0 && (
            <div className="coding-provider-select-empty">No providers registered on the backend.</div>
          )}
          {providers.map((provider) => {
            const selected = provider.providerId === value;
            return (
              <button
                type="button"
                key={provider.providerId}
                role="option"
                aria-selected={selected}
                className={`coding-provider-select-option ${selected ? "selected" : ""}`}
                onClick={() => void connect(provider.providerId)}
                title={provider.status.installed ? "Connect" : `${provider.name} is not installed — ${provider.installHint ?? "install it first"}`}
              >
                <span className="coding-provider-select-name">{provider.name}</span>
                <span className={`coding-provider-state ${provider.status.installed ? "good" : "bad"}`}>
                  {provider.status.installed
                    ? <><CheckCircle2 size={11} /> installed</>
                    : <><CircleSlash size={11} /> missing</>}
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
