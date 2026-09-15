"use client";

import { useEffect, useState } from "react";
import { connectEvents, type FinanceEvent, type SSEOptions } from "./api";

export function useFinanceEvents(
  opts?: SSEOptions,
  onEvent?: (event: FinanceEvent) => void
) {
  const [events, setEvents] = useState<FinanceEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let sub: ReturnType<typeof connectEvents> = null;

    sub = connectEvents(
      (ev) => {
        setEvents((prev) => [ev, ...prev].slice(0, 100));
        onEvent?.(ev);
      },
      (comment) => {
        if (comment === "connected") {
          setConnected(true);
        }
      },
      opts
    );

    return () => {
      sub?.close();
      setConnected(false);
    };
  }, [opts?.channelId, opts?.threadId, opts?.agentId, opts?.type, onEvent]);

  return { events, connected };
}
