# FinanceBot Database Design

Status: Phase 1 architecture deliverable. This is the storage contract for FinanceBot's coworker platform; it plans the durable models introduced **before** channels and tasks go to production, per `FINANCEBOT_ARCHITECTURE.md` §Persistence boundaries. Existing JSON-file persistence remains valid until a model here is implemented.

## Design principles

1. **Business keys are typed IDs** — `ag_`, `wf_`, `ws_`, `ch_`, `ce_`, `tk_`, `ru_`, `ta_`, `au_`, `ap_`, `vb_` prefixed ULIDs, so ids sort by creation time and survive export/import.
2. **No secrets in the database.** Provider connections store env-var-name references and health metadata only. Secret values live in environment config or the OS credential store (see `FINANCEBOT_SECURITY.md`).
3. **Append-only event streams.** Channel events, run events, audit events and tool-call records are immutable rows; corrections are new rows referencing the previous event (e.g. `task_reassigned` supersedes `task_assigned`).
4. **Everything the risk pipeline needs is deterministic data.** Approval tickets, kill-switch state and limit counters keep their file/Electron-safe representations; this database never becomes a bypass path around the 7-stage execution pipeline.
5. **Sanitise before insert.** Every free-text column passes through `sanitizeSecrets()` (`apps/server/src/memory/agent-memory.ts`); the same `/^(api[_-]?key|secret|token|password|credential)/i` redaction applies to stored JSON payloads.

## Engine choice

SQLite (via the existing Prisma schema in `prisma/`) for the single-user desktop install. All tables below carry `createdAt` / `updatedAt`. Postgres migration is a lift-and-shift of the same schema when (and only when) multi-process access is actually needed (`README.md` → Future).

## Core tables

### Coworkers & instructions

```sql
coworkers (
  id TEXT PRIMARY KEY,                    -- ag_*
  slug TEXT UNIQUE NOT NULL,             -- e.g. finance-lead
  display_name TEXT NOT NULL,
  role TEXT NOT NULL,                    -- supervisor | quant | risk | execution | research | portfolio | finance_lead | custom
  kind TEXT NOT NULL DEFAULT 'custom',   -- builtin | custom; builtin rows cannot be archived/deleted
  system_prompt TEXT NOT NULL,           -- versioned via coworker_instructions
  engine_id TEXT NOT NULL,               -- FK engines
  model TEXT,                            -- optional per-coworker model override
  tools_json TEXT NOT NULL DEFAULT '[]', -- tool allowlist (names only)
  permissions_json TEXT NOT NULL,        -- { execution: false, ... }
  risk_permissions_json TEXT NOT NULL,   -- { allowTradeProposals: false, ... }
  memory_scope TEXT NOT NULL DEFAULT 'conversation', -- conversation | agent | global
  status TEXT NOT NULL DEFAULT 'idle',   -- idle | working | queued | error | archived
  current_task_id TEXT,                  -- FK tasks (nullable, denormalised for the Coworkers page)
  archived_at INTEGER
)

coworker_instructions (
  id TEXT PRIMARY KEY,                   -- vi_*
  coworker_id TEXT NOT NULL REFERENCES coworkers(id),
  version INTEGER NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT, created_at INTEGER,
  UNIQUE (coworker_id, version)
)
```

The runtime (`apps/server/src/llm/agent-runtime.ts`) keeps hydrated copies in memory; this table is the durable authority it loads through `AgentPersistence` today and through a repository later.

### Workspaces & channels

```sql
workspaces (
  id TEXT PRIMARY KEY,                   -- ws_*
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
)

channels (
  id TEXT PRIMARY KEY,                   -- ch_*
  workspace_id TEXT REFERENCES workspaces(id),
  slug TEXT NOT NULL,                    -- e.g. btc-research
  purpose TEXT NOT NULL,                 -- research | risk_review | quant_lab | briefing
  topic TEXT, created_at INTEGER,
  UNIQUE (workspace_id, slug)
)

channel_members (
  channel_id TEXT REFERENCES channels(id),
  coworker_id TEXT REFERENCES coworkers(id),
  role TEXT NOT NULL DEFAULT 'member',   -- member | moderator
  PRIMARY KEY (channel_id, coworker_id)
)

channel_events (
  id TEXT PRIMARY KEY,                   -- ce_*
  channel_id TEXT NOT NULL REFERENCES channels(id),
  seq INTEGER NOT NULL,                  -- per-channel monotonic (UNIQUE(channel_id, seq)); replay cursor
  type TEXT NOT NULL,                    -- message | task_created | handoff | tool_result | approval_requested | task_completed | system
  actor_kind TEXT NOT NULL,              -- user | coworker | system
  actor_id TEXT,                         -- coworkers.id or 'user'
  body TEXT,                             -- markdown; sanitised
  refs_json TEXT,                        -- [{ kind: 'task'|'run'|'tool_result'|'evidence', id }]
  created_at INTEGER NOT NULL
)
```

### Tasks, runs & attempts

```sql
tasks (
  id TEXT PRIMARY KEY,                   -- tk_*
  title TEXT NOT NULL,
  description TEXT,                      -- sanitised markdown
  workspace_id TEXT, channel_id TEXT,
  created_by TEXT NOT NULL,              -- 'user' or agent id
  assigned_to TEXT REFERENCES coworkers(id),
  priority TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
  status TEXT NOT NULL DEFAULT 'queued',     -- queued | assigned | running | waiting_approval | blocked | done | failed | cancelled
  depends_on_json TEXT NOT NULL DEFAULT '[]', -- [task ids]
  attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 3,
  due_at INTEGER, created_at INTEGER, updated_at INTEGER,
  CHECK (status IN ('queued','assigned','running','waiting_approval','blocked','done','failed','cancelled'))
)

task_transitions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES tasks(id),
  from_status TEXT, to_status TEXT NOT NULL,
  reason TEXT, actor_id TEXT, created_at INTEGER NOT NULL
)

runs (
  id TEXT PRIMARY KEY,                   -- ru_*
  task_id TEXT REFERENCES tasks(id),
  coworker_id TEXT NOT NULL REFERENCES coworkers(id),
  trigger TEXT NOT NULL,                 -- chat | task | schedule | handoff
  conversation_id TEXT,                  -- llm conversation reference (AgentPersistence today)
  status TEXT NOT NULL,                  -- running | done | failed | stopped | preempted
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at INTEGER NOT NULL, ended_at INTEGER,
  outcome_json TEXT                      -- summary, token usage, error (sanitised)
)

run_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,                    -- message_start | text_delta | tool_call | tool_result | step_failed | plan_failed | message_complete
  payload_json TEXT NOT NULL,            -- sanitised
  created_at INTEGER NOT NULL,
  UNIQUE (run_id, seq)
)
```

The current **exclusive runtime lock** stays as-is: this design gives each run an isolated `runs`/`run_events` row so a future concurrent runtime (roadmap Stage 3) has its state model ready without touching the lock today.

### Money & evidence references (no duplication of trading state)

The portfolio, orders and risk state remain owned by the existing services (`apps/server/src/finance-*`, `risk-engine`, `order-manager`, `paper broker`). FinanceBot stores **references and human-readable conclusions**, never a second source of truth:

```sql
research_notes (
  id TEXT PRIMARY KEY,                   -- rn_*
  channel_id TEXT, task_id TEXT, run_id TEXT,
  asset TEXT,                            -- e.g. BTCUSDT (nullable)
  summary TEXT NOT NULL,                 -- sanitised markdown
  claim_kind TEXT NOT NULL,              -- fact | inference | hypothesis
  confidence REAL,                       -- 0..1; required for inference/hypothesis
  snapshot_json TEXT,                    -- measured values used (price, ts, source)
  created_at INTEGER NOT NULL
)

evidence_links (
  id TEXT PRIMARY KEY,                   -- ev_*
  note_id TEXT NOT NULL REFERENCES research_notes(id),
  url TEXT NOT NULL,
  publisher TEXT,
  published_at INTEGER, observed_at INTEGER,
  freshness_class TEXT NOT NULL          -- fresh | stale | unknown
)
```

No fabricated numbers: a note without a `snapshot_json` measurement or an evidence link must be labelled `inference`/`hypothesis` by the writing agent, and the UI renders it as such.

### Approvals & tool calls (audit surface)

```sql
tool_calls (
  id TEXT PRIMARY KEY,                   -- tc_*
  run_id TEXT NOT NULL REFERENCES runs(id),
  tool_name TEXT NOT NULL,
  args_redacted TEXT NOT NULL,           -- sanitised arguments
  result_summary TEXT,                   -- sanitised; large payloads go to artifact store
  error TEXT,
  allowed_by TEXT NOT NULL,              -- allowlist rule that admitted it, or 'deny:<reason>'
  started_at INTEGER NOT NULL, duration_ms INTEGER
)

audit_events (
  id TEXT PRIMARY KEY,                   -- au_*
  kind TEXT NOT NULL,                    -- tool_call | approval_granted | approval_denied | provider_error | settings_change | conversation_deleted
  actor_kind TEXT NOT NULL, actor_id TEXT,
  subject TEXT NOT NULL,                 -- e.g. 'ag_x/tool_call:tc_y'
  detail_json TEXT,                      -- sanitised
  created_at INTEGER NOT NULL
)

approvals (
  id TEXT PRIMARY KEY,                   -- ap_*
  task_id TEXT, run_id TEXT,
  kind TEXT NOT NULL,                    -- trade_proposal | tool_use | settings
  status TEXT NOT NULL,                  -- pending | granted | denied | expired
  risk_ticket_ref TEXT,                  -- HMAC RiskApprovalTicket id from risk-engine (hash only)
  decided_by TEXT, decided_at INTEGER,
  expires_at INTEGER
)
```

### Provider connections (metadata only)

```sql
provider_connections (
  id TEXT PRIMARY KEY,                   -- pb_*
  provider_id TEXT NOT NULL,             -- registry key (openai, anthropic, ...)
  label TEXT,
  base_url TEXT,
  credential_ref TEXT NOT NULL,          -- env var name or OS-keystore key; NEVER a secret value
  timeout_ms INTEGER NOT NULL DEFAULT 30000,
  fallbacks_json TEXT NOT NULL DEFAULT '[]',
  health_status TEXT,                    -- ok | degraded | down | unverified
  health_checked_at INTEGER,
  created_at INTEGER, updated_at INTEGER
)

provider_models_cache (
  provider_connection_id TEXT REFERENCES provider_connections(id),
  model_id TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,       -- streaming/tools/reasoning/context — from real API only
  discovered_at INTEGER,
  PRIMARY KEY (provider_connection_id, model_id)
)
```

## Indices & integrity

- `tasks(status, priority, due_at)`, `tasks(assigned_to, status)` for the Tasks page.
- `channel_events(channel_id, seq)` replay cursor; `runs(coworker_id, started_at DESC)`; `run_events(run_id, seq)`; `audit_events(created_at DESC)`.
- All task status moves and approval decisions are single transactions writing both the row and its `task_transitions`/`audit_events` record.
- Retention/export: `research_notes`, `run_events`, `audit_events` expose export or delete per conversation/agent — the desktop Settings → Data page surfaces this when implemented.

## Honest status

Nothing in this file is implemented yet beyond what already runs (`AgentPersistence` JSON files in `~/.finance-agent`, Prisma for the dev database). Until a table here ships, the JSON persistence stays authoritative and this document marks the contract any future migration must satisfy.
