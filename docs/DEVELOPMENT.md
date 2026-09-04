# Development

## Prerequisites

- Node.js 18+
- pnpm 9+

## Quick Start

```bash
# Install dependencies
pnpm install

# Start development
pnpm dev

# Or start server only
pnpm dev:server
```

## Commands

| Command | Description |
|---------|-------------|
| `pnpm install` | Install all dependencies |
| `pnpm dev` | Start all apps in dev mode |
| `pnpm dev:server` | Start server only |
| `pnpm dev:dashboard` | Start dashboard only |
| `pnpm build` | Build all packages |
| `pnpm test` | Run all tests |
| `pnpm typecheck` | Type-check all packages |
| `pnpm start` | Start production server |

## Project Structure

```
finance-agent-os/
├── packages/
│   ├── shared/          — Shared types and models
│   └── core/            — Core runtime, event bus, registries
├── apps/
│   ├── server/          — Backend server (Fastify)
│   └── dashboard/       — Frontend dashboard (Next.js)
├── prisma/              — Database schema
├── docs/                — Documentation
└── scripts/             — Build/deploy scripts
```

## Testing

```bash
# Run all tests
pnpm test

# Run specific package tests
pnpm --filter @finance/core test
pnpm --filter @finance/server test
```

## Architecture

See `docs/ARCHITECTURE.md` for the full architecture overview.
