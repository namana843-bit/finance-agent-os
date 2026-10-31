import { useEffect, useState } from "react";
import App from "./App";
import EnginesPage from "./app/engines/page";
import TeamPage from "./app/team/page";
import CodingPage from "./app/coding/page";
import HomePage from "./app/home/page";
import WorkspacePage from "./app/workspace/page";
import CoworkersPage from "./app/coworkers/page";
import ChannelsPage from "./app/channels/page";
import TasksPage from "./app/tasks/page";
import SettingsPage from "./app/settings/page";
import { AppShell } from "./app/shell/AppShell";
import { canonicalRoute, currentHashRoute, navigate } from "./app/shell/nav";

function NotFound({ route }: { route: string }) {
  return (
    <div className="flex min-h-[50vh] flex-col items-center justify-center text-center">
      <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-neutral-600">404</div>
      <h1 className="mt-2 text-[20px] font-semibold text-neutral-100">No screen at {route}</h1>
      <p className="mt-1.5 max-w-sm text-[11.5px] leading-relaxed text-neutral-500">
        The route does not exist in this build. Use the sidebar or return to Home.
      </p>
      <button
        type="button"
        onClick={() => navigate("/home")}
        className="mt-4 rounded-md bg-emerald-500 px-3 py-1.5 text-[11.5px] font-semibold text-emerald-950 hover:bg-emerald-400"
      >
        Go to Home
      </button>
    </div>
  );
}

function ShellRoute({ route, children }: { route: string; children: React.ReactNode }) {
  return <AppShell activeRoute={route}>{children}</AppShell>;
}

function renderRoute(path: string) {
  const route = canonicalRoute(path);
  switch (route) {
    case "/home":
      return (
        <ShellRoute route="/home">
          <HomePage />
        </ShellRoute>
      );
    case "/workspace":
      return (
        <ShellRoute route="/workspace">
          <WorkspacePage />
        </ShellRoute>
      );
    case "/coworkers":
      return (
        <ShellRoute route="/coworkers">
          <CoworkersPage />
        </ShellRoute>
      );
    case "/channels":
      return (
        <ShellRoute route="/channels">
          <ChannelsPage />
        </ShellRoute>
      );
    case "/tasks":
      return (
        <ShellRoute route="/tasks">
          <TasksPage />
        </ShellRoute>
      );
    case "/settings":
      return (
        <ShellRoute route="/settings">
          <SettingsPage />
        </ShellRoute>
      );
    case "/terminal":
      return <App />;
    case "/team":
      return <TeamPage />;
    case "/engines":
      return <EnginesPage />;
    case "/coding":
      return <CodingPage />;
    default:
      return (
        <ShellRoute route="/home">
          <NotFound route={path} />
        </ShellRoute>
      );
  }
}

export function Root() {
  const [route, setRoute] = useState(currentHashRoute);

  useEffect(() => {
    const onChange = () => setRoute(currentHashRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return <>{renderRoute(route)}</>;
}

export default Root;
