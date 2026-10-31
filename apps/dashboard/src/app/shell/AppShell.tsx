import type { ReactNode } from "react";
import { Sidebar } from "./Sidebar";
import { TopBar } from "./TopBar";
import { WorkspaceProvider } from "./workspace-data";

export function AppShell({ activeRoute, children }: { activeRoute: string; children: ReactNode }) {
  return (
    <WorkspaceProvider>
      <div className="flex h-full min-h-0 w-full overflow-hidden bg-[#07080a] text-neutral-200">
        <Sidebar activeRoute={activeRoute} />
        <div className="flex min-w-0 flex-1 flex-col">
          <TopBar activeRoute={activeRoute} />
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1500px] px-6 pb-14 pt-7">{children}</div>
          </main>
        </div>
      </div>
    </WorkspaceProvider>
  );
}
