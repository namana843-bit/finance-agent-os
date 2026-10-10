// ============================================================================
// Finance Agent OS — Generic CLI Adapter Layer
//
// Why: the platform used to be hard-coded around OpenCode (path tables,
// `--agent/--model` argv surgery, JSON-line parsing, daemon handling, allowlist
// spreads across 5+ files). A new CLI (Claude Code, Codex, Gemini, …) required
// edits in the core streaming code — the wrong coupling.
//
// Now: Desktop UI → CLI Manager → CLI Adapter Interface → implementations.
// OpenCode is just one adapter. Adding a CLI = one new adapter class +
// one registration line. Core runtime and desktop UI never change.
//
// Files:
//   apps/server/src/cli/types.ts               metadata · validation · options
//                                              task/result · normalized events
//                                              hooks + CliAdapter contract
//   apps/server/src/cli/resolver.ts            generic cross-platform path
//                                              discovery (<COMMAND>_CLI_PATH
//                                              overrides, PATH probe, npm/
//                                              cargo/system fallbacks)
//   apps/server/src/cli/parsing.ts             shared JSON-lines protocol parser
//   apps/server/src/cli/adapter-base.ts        default behaviour (argv
//                                              templates, matching, env, probes)
//   apps/server/src/cli/process-runner.ts      the only module that spawns CLI
//                                              processes (no shell, explicit
//                                              env, timeout, cancellation)
//   apps/server/src/cli/cli-manager.ts         register · list · validate ·
//                                              start · sendTask · streamEvents
//                                              · stop · normalized `cli.*` bus
//   apps/server/src/cli/adapters/
//     opencode-paths.ts                        ALL OpenCode specifics: path
//                                              candidates, env override,
//                                              version probe, allowlist,
//                                              daemon args, attach flags
//     opencode-adapter.ts                      OpenCodeAdapter (argv, parsing,
//                                              validation, daemon ownership)
//     opencode-daemon.ts                       `opencode serve …` lifecycle
//     custom-adapter.ts                        descriptor-driven CLIs
//   apps/server/src/cli/index.ts               registration layer — the only
//                                              place that names adapters
//
// Events (normalized, published as `cli.<type>` on the platform bus):
//   session_started · output(stdout/stderr) · tool_activity · status_changed
//   error · session_finished · session_failed
//
// ## Adding a new CLI adapter (no core changes)
//
// 1. Implement the contract (~80 lines with the base class) in
//    `apps/server/src/cli/adapters/<name>-adapter.ts` — one level below
//    `cli/`, so the shared base/types are reached with a single `../`
//    (the same specifiers the shipped adapters use):
//
//      import { CliAdapterBase } from "../adapter-base.js";
//      import type { CliStreamChunk } from "../types.js";
//
//      export class NewCliAdapter extends CliAdapterBase {
//        constructor() {
//          super({
//            id: "newcli",
//            name: "New CLI",
//            description: "My agent CLI",
//            executable: "newcli",
//            supportsStreaming: true,
//            supportsCancellation: true,
//            taskDelivery: "argv",
//            defaultArgs: ["run", "{prompt}"],
//            engineAliases: ["newcli"],
//          });
//        }
//
//        override requiresShell(_executable: string): boolean {
//          return false;
//        }
//
//        override parseLine(line: string): CliStreamChunk | null {
//          const trimmed = line.trim();
//          if (trimmed.startsWith("RESULT:")) {
//            return { type: "delta", content: trimmed.slice("RESULT:".length) };
//          }
//          return super.parseLine(line);
//        }
//      }
//
// 2. Register it (THE ONLY core-touching line):
//
//      // apps/server/src/cli/index.ts → createDefaultCliManager()
//      manager.register(new NewCliAdapter());
//
// 3. That's it: the adapter appears in `GET /api/cli/adapters`, validates via
//    `POST /api/cli/adapters/newcli/validate`, runs tasks through
//    `POST /api/cli/sessions[/:id/tasks]`, renders in the desktop "Agent CLIs"
//    panel, and can back LLM engines via `CliManager.findByEngineId()`
//    (which `EngineManager` consumes in `llm/registry.ts`).
//
// For quick, one-off CLIs that already use `run {prompt}` conventions, skip
// step 1 and use the descriptor-driven `CustomCliAdapter`:
//
//      manager.register(createCustomCliAdapter({
//        id: "my-agent",
//        name: "My Agent",
//        executablePath: "/path/to/agent",
//        workingDirectory: "/project",
//        args: ["run", "{prompt}"],
//      }));
//
// Security model (unchanged by this refactor — audit these files):
//   • process spawning ONLY in cli/process-runner.ts (direct spawn, windowsHide,
//     bounded buffers, hard timeout, AbortSignal kill, process-tree cleanup)
//   • `shell: true` ONLY when an adapter declares OS wrappers via
//     `requiresShell()` (.cmd/.bat/.ps1); user task text travels as argv or
//     stdin data, never in a shell command string
//   • the OpenCode permissioned gateway keeps its allowlist + metachar
//     rejection (gateway/opencode-cli-gateway.ts) on top of the adapter
//   • `cli.*` bus events are system events: `/api/publish` rejects them
// ============================================================================
