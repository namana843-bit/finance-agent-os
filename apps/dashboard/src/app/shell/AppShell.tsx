import type { ReactNode } from "react";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { cn } from "../../lib/utils";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { WorkspaceProvider } from "./workspace-data";

export function AppShell({ activeRoute, children }: { activeRoute: string; children: ReactNode }) {
  const [sidebarOpen, setSidebarOpen] = useState(false);

  return (
    <WorkspaceProvider>
      <div className="flex h-full min-h-0 w-full overflow-hidden bg-[#07080a] text-neutral-200">
        {/* Mobile sidebar overlay */}
        <aside
          className={cn(
            "fixed inset-y-0 left-0 z-50 w-[248px] flex flex-col border-r border-white/[0.06] bg-[#0a0b0e] transform transition-transform duration-300 ease-in-out",
            sidebarOpen ? "translate-x-0" : "-translate-x-full",
            "lg:static lg:translate-x-0 lg:flex",
          )}
        >
          <div className="flex items-center justify-between px-3 pb-3 pt-4">
            <div className="flex items-center gap-2.5 px-1">
              <div className="relative flex h-8 w-8 items-center justify-center rounded-[10px] bg-gradient-to-br from-emerald-400 to-teal-600 text-[13px] font-bold text-emerald-950 shadow-[0_0_20px_-6px_rgba(52,211,153,0.7)]">
                F
                <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full border-2 border-[#0a0b0e] bg-emerald-400" />
              </div>
              <div className="min-w-0">
                <div className="text-[13px] font-semibold leading-none tracking-tight text-neutral-100">FinanceBot</div>
                <div className="mt-1 font-mono text-[9px] uppercase tracking-[0.16em] text-neutral-600">
                  AI financial teammate
                </div>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden rounded-lg p-1.5 text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-200 transition-colors"
              aria-label="Close sidebar"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <Sidebar activeRoute={activeRoute} />
        </aside>

        {/* Mobile backdrop */}
        {sidebarOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/40 lg:hidden"
            onClick={() => setSidebarOpen(false)}
            aria-hidden="true"
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col lg:pl-[248px]">
          <TopBar activeRoute={activeRoute} onSidebarToggle={() => setSidebarOpen((prev) => !prev)} />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="w-full px-6 pb-14 pt-7">{children}</div>
          </main>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
