"use client";
import { useEffect, useState } from "react";
import { connectEvents, type FinanceEvent } from "./api";

export function useFinanceEvents(filter?: { type?: string; limit?: number }, onEvent?: (e: FinanceEvent) => void) {
  const [events, setEvents] = useState<FinanceEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const handle = connectEvents(
      (ev) => {
        setEvents((prev) => [ev, ...prev].slice(0, 400));
        onEvent?.(ev);
      },
      () => setConnected(true),
      { type: filter?.type, replay: true, limit: filter?.limit ?? 80 }
    );
    if (!handle) return;
    const es = handle.source;
    const onOpen = () => setConnected(true);
    const onError = () => setConnected(false);
    es.addEventListener("open", onOpen);
    es.addEventListener("error", onError as EventListener);
    return () => {
      es.removeEventListener("open", onOpen);
      es.removeEventListener("error", onError as EventListener);
      handle.close();
      setConnected(false);
    };
    // filter.type string dep is stable
  }, [filter?.type, filter?.limit]);

  return { events, connected, setEvents };
}
