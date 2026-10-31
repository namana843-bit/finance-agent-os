# FinanceBot Delivery Roadmap

This roadmap sequences the OpenBot-inspired product into safe, testable increments. It is a delivery plan, not a claim that every feature is already implemented.

## Stage 0 — Desktop product foundation
- Rebrand Electron window and dashboard document as FinanceBot.
- Keep existing Team, Engines, Terminal and Coding surfaces available.
- Publish architecture, trust boundaries, provider strategy and acceptance criteria.
- No changes to order execution or runtime concurrency.

## Stage 1 — Workspace shell and agent directory
- Introduce a consistent desktop navigation shell.
- Add agent profile management for identity, instructions, model, tool allowlist and memory scope.
- Reuse existing agent CRUD APIs where possible; add schema validation and permission tests.
- Make provider connection state visible without rendering secrets.

## Stage 2 — Persistent collaboration
- Add workspaces, channels, typed channel events and message history.
- Add durable tasks with queue, assignment, priorities, dependencies, retry and cancellation.
- Add agent handoff and Supervisor synthesis with source references.
- Add database migrations and audit records before production use.

## Stage 3 — Safe concurrent runtime
- Replace the current exclusive AgentRuntime lock only after run IDs, task IDs, per-run abort handling, idempotency and concurrency tests are complete.
- Isolate conversation state and tool execution context per run.
- Add limits, timeouts, queue backpressure and cancellation semantics.
- Keep side-effecting tools behind explicit capabilities and approval.

## Stage 4 — Multi-provider settings and routing
- Add connection setup for native, compatible and CLI provider families.
- Add model discovery, capability metadata, health checks and per-agent defaults.
- Use OS credential storage in desktop builds; never store secrets in browser local storage or SQLite.
- Add redaction and provider contract tests.

## Stage 5 — Finance-native collaboration
- Research channels for assets, strategies, macro and portfolio topics.
- Evidence packets with source URL, publisher, observed/published timestamps, freshness and fact-vs-inference labels.
- Strategy review, independent risk challenge and paper-trade proposal preparation.
- Reuse market, backtest, portfolio and risk services rather than duplicating calculations.

## Stage 6 — Production readiness
- Threat model, local API authentication, secure IPC, CSP and signed desktop builds.
- Data retention/export/deletion controls and audit review.
- Provider failure handling, observability, evaluations and regression suite.
- Release only after all risk, paper-broker and execution-pipeline tests pass.

## Release gates

- No regression in the existing server test suite.
- New tests for concurrent run isolation, tool permissions, cancellation, task transitions, provider secret redaction and desktop IPC boundaries.
- Existing risk-gate, HMAC ticket, kill-switch, workflow approval and paper-broker tests remain green.
- No live trading enablement is part of the initial FinanceBot release.
