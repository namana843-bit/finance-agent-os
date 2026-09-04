"use client";
import { DesktopShell } from "@/components/desktop/Shell";

// Finance Agent Desktop — OpenMausBot-inspired modular shell.
// All finance logic stays on backend (apps/server); dashboard only
// composes existing APIs (/api/portfolio, /api/market/ticks, /api/events SSE, /api/publish)
// via reusable panels. No backend rewrite.
export default function DashboardPage() {
  return <DesktopShell />;
}
