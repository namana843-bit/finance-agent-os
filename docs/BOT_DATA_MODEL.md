# Bot Data Model (Step 1)

Persistent storage for custom coworker bots. Prisma models in
`prisma/schema.prisma` (additive — applied with `prisma db push`, no
migrations directory in this repo). Typed access via
`apps/server/src/bots/bot-store.ts` (`BotStore`, injected `PrismaClient`).

## Tables

| Model | Purpose | Key fields |
| --- | --- | --- |
| `BotProfile` | Bot identity + config | name, description, systemPrompt, engine (CLI provider id), model?, settingsJson, toolsJson, status (`active`/`archived`), ownerId? |
| `BotSession` | One conversation thread | botId → BotProfile (Restrict), title?, status (`active`/`closed`/`archived`), configJson, closedAt? |
| `BotMessage` | Chat history | sessionId → BotSession (Restrict), role (`user`/`assistant`/`tool`/`system`), content, metadataJson |
| `ProviderSessionMapping` | External CLI session id for resumption | sessionId → BotSession (Restrict), providerId, externalSessionId; unique on (sessionId, providerId) |

## Rules

- **Retention:** default lifecycle is soft (`archiveBot`, data retained, hidden
  from active lists). Hard delete only via `purgeBot()`, which removes
  mappings → messages → sessions → bot in one transaction. Direct deletes of
  bots with children fail at the DB level (`Restrict`) — intentional.
- **Secrets:** `systemPrompt`/`settings`/`config` are scanned for obvious
  secret keys (`api_key`, tokens, passwords…) and rejected before write.
- **No duplication:** `CliSessionManager` still owns live CLI processes and
  `AgentRuntime` still owns the reasoning loop; this layer is persistence
  only. The mapping table bridges them for providers with resumption
  (e.g. Cline `-T`).
- **Existing DBs:** additive tables only — `db push` never touches the 9
  existing models. Tests use an isolated temp SQLite file, never `dev.db`.
