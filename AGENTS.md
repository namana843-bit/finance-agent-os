# Instructions for Coding Agents

This document contains operational instructions, architecture constraints, and coding standards for AI coding agents (and human contributors) working on **Finance Agent OS**.

---

## 1. Project Overview & Monorepo Structure

Finance Agent OS is an event-driven, multi-agent autonomous financial platform with a desktop interface and Fastify backend.

```
finance-agent-os/
├── apps/
│   ├── server/           # Fastify backend, agent runtime, execution pipeline (:4132)
│   └── dashboard/        # Vite + React 18 + TailwindCSS + Electron desktop UI (:3000)
├── packages/
│   ├── core/             # BaseAgent, TypedEventBus, FinanceRuntime
│   └── shared/           # Types, event schemas, risk ticket interfaces
├── docs/                 # System documentation & specifications
├── prisma/               # Prisma database schema (SQLite / dev)
└── opencode.json         # OpenCode multi-agent configuration
```

### Key Technologies
- **Backend**: Node.js, TypeScript (ESM with `.js` import specifiers), Fastify, Vitest
- **Frontend**: React 18, Vite, TailwindCSS, Lucide React, Electron
- **Shared Core**: `@finance/core` (TypedEventBus), `@finance/shared` (Domain types)
- **Package Manager**: `pnpm` (workspaces)

---

## 2. Environment & Tooling Commands

Always run commands from the workspace root or filter explicitly with pnpm:

```bash
# Install dependencies
pnpm install

# Run backend test suite
pnpm --filter @finance/server test

# Run tests in watch mode
pnpm --filter @finance/server test:watch

# Build packages and apps
pnpm build

# Start server development mode
pnpm --filter @finance/server dev

# Start dashboard development mode
pnpm --filter @finance/dashboard dev
```

---

## 3. Strict Development Guidelines

### A. ESM Imports & File Extensions
- The server codebase uses Node.js ES Modules (`"type": "module"`).
- **All relative imports within TypeScript files in `apps/server` and `packages/` must include the `.js` extension** (e.g., `import { foo } from "./bar.js";`), even though the source file is `bar.ts`.
- Omitting the `.js` extension causes Node/Vitest module resolution failures.

### B. Secrets & Sanitization
- **Never commit `.env` files, API keys, private keys, or credentials.**
- When writing agent memory, logs, or traces, always pass payloads through `sanitizeSecrets()` (`apps/server/src/memory/agent-memory.ts`).
- Any key matching `/^(api[_-]?key|secret|token|password|credential)/i` must be redacted to `"[REDACTED]"`.

### C. Risk & Execution Safety (Non-Bypassable)
- **Trading is paper-only by default.**
- Live trading is gated behind `EXECUTION_MODE=live`, `LIVE_TRADING_ENABLED=true`, and explicit HMAC risk approval tickets.
- **Never bypass deterministic risk gates.** Do not allow LLMs or agents to submit orders directly to brokers without passing through the 7-stage execution pipeline (`apps/server/src/execution-pipeline/pipeline.ts`).
- Every order must carry a valid, unexpired HMAC-SHA256 `RiskApprovalTicket` (`apps/server/src/risk-engine/ticket.ts`).

### D. Concurrency & Preemption
- The agent runtime (`apps/server/src/llm/agent-runtime.ts`) implements an **exclusive execution lock**.
- Starting an agent run preempts/aborts in-flight tool runs of other agents via `AbortController`.
- Respect abort signals in asynchronous loops (`if (isAborted()) break;`).

### E. Storage & File Persistence
- Prefer atomic file writes (`writeFileAtomic` in `apps/server/src/atomic.ts`) for JSON persistence (`agent-memory.json`, `orders.json`) to prevent corruption under sudden termination or Windows file-locking conditions (`EPERM`/`EBUSY`).
- Temporary/scratch logs belong in `scratch/` or `.data/`, which are ignored by Git.

---

## 4. Verification Workflow Before Committing

Before submitting or pushing changes:
1. **Check Types & Lint**: Ensure no broken TypeScript types in modified packages.
2. **Run Tests**: Execute `pnpm --filter @finance/server test` to confirm test suite integrity.
3. **Verify Git Status**: Ensure untracked cache files, SQLite `.db` binaries, and temporary logs are not staged.
4. **Preserve Integrity**: Do not refactor application logic unless directly required by the task.
