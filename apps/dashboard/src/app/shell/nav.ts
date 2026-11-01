import {
  Briefcase,
  Home,
  MessageSquare,
  Radio,
  Settings,
  SquareTerminal,
  Users,
  type LucideIcon,
} from "lucide-react";

export type NavItem = {
  route: string;
  label: string;
  icon: LucideIcon;
  description: string;
  /** Extra aliases that should resolve to this route. */
  aliases?: string[];
};

export const PRIMARY_NAV: NavItem[] = [
  { route: "/home", label: "Home", icon: Home, description: "Workspace overview and activity" },
  { route: "/workspace", label: "AI Workspace", icon: MessageSquare, description: "Talk to a coworker" },
  { route: "/coworkers", label: "Coworkers", icon: Users, description: "Agent directory, models and status" },
  { route: "/channels", label: "Channels", icon: Radio, description: "Persistent research threads" },
  { route: "/tasks", label: "Tasks", icon: Briefcase, description: "Workflow runs and approvals" },
  {
    route: "/terminal",
    label: "Finance Terminal",
    icon: SquareTerminal,
    description: "Portfolio, risk, orders and telemetry",
    aliases: ["/dashboard"],
  },
  { route: "/settings", label: "Settings", icon: Settings, description: "Providers, engines and safety" },
];

/** Screens that keep the original standalone layouts and are linked from the shell. */
export const LEGACY_SCREENS: NavItem[] = [
  { route: "/team", label: "Agent Team", icon: Users, description: "Original team workbench" },
  { route: "/engines", label: "Model Engines", icon: SquareTerminal, description: "CLI engines and model registry" },
  { route: "/coding", label: "Coding Agents", icon: SquareTerminal, description: "Coding sessions and worktrees" },
];

export function currentHashRoute(): string {
  const raw = window.location.hash.replace(/^#/, "");
  const path = raw.split("?")[0] || "/home";
  return path === "/" || path === "" ? "/home" : path;
}

export function currentHashQuery(): URLSearchParams {
  const raw = window.location.hash.replace(/^#/, "");
  const index = raw.indexOf("?");
  return new URLSearchParams(index === -1 ? "" : raw.slice(index + 1));
}

export function navigate(route: string, query?: Record<string, string | undefined>) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value) params.set(key, value);
  }
  const qs = params.toString();
  window.location.hash = `${route}${qs ? `?${qs}` : ""}`;
}

/** Resolve a route to its canonical form, following aliases. */
export function canonicalRoute(path: string): string {
  for (const item of PRIMARY_NAV) {
    if (item.route === path || item.aliases?.includes(path)) return item.route;
  }
  for (const item of LEGACY_SCREENS) {
    if (item.route === path) return item.route;
  }
  return path;
}

export function routeLabel(path: string): string {
  const canonical = canonicalRoute(path);
  return (
    [...PRIMARY_NAV, ...LEGACY_SCREENS].find((item) => item.route === canonical)?.label ?? "Workspace"
  );
}
