# Workspace

## Overview

pnpm workspace monorepo using TypeScript. Each package manages its own dependencies.

## Stack

- **Monorepo tool**: pnpm workspaces
- **Node.js version**: 24
- **Package manager**: pnpm
- **TypeScript version**: 5.9
- **API framework**: Express 5
- **Database**: PostgreSQL + Drizzle ORM
- **Validation**: Zod (`zod/v4`), `drizzle-zod`
- **API codegen**: Orval (from OpenAPI spec)
- **Build**: esbuild (CJS bundle)

## Key Commands

- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- `pnpm --filter @workspace/api-server run dev` — run API server locally

See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details.

## AI Portfolio Strategist

Sophisticated dark-themed AI investment dashboard at `/` (artifact `artifacts/portfolio-strategist`, kind `web`).

### Sidebar Pages
Dashboard, Goals & Strategy, Portfolio, Trade Assistant, Rebalancing, Performance, Transactions, Risk & Alerts, Backtesting, Settings.

### Backend (`artifacts/api-server`)
- DB schemas in `lib/db/src/schema/`: `profile`, `holdings`, `targetAllocations`, `tradeSuggestions`, `transactions`, `riskAlerts`, `assistantMessages`.
- Routes in `artifacts/api-server/src/routes/`: `user`, `goals`, `strategy`, `portfolio`, `performance`, `trades`, `rebalancing`, `transactions`, `alerts`, `assistant`, `dashboard`, all mounted under `/api`.
- Helper libs: `profile.ts`, `portfolio.ts`, `performance.ts`, `aiResponder.ts`.
- Seed: `artifacts/api-server/src/seed.ts`. To run: bundle with esbuild and execute `node dist/seed.mjs`.

### Frontend
- React + Vite + TanStack Query + wouter + Tailwind (dark default via `localStorage('theme')`).
- Generated hooks via Orval in `lib/api-client-react`. Mutations take `{ data: { ... } }` for POST/PUT bodies; query invalidation uses `getXxxQueryKey()` helpers.
- Charts: Recharts via `components/charts/AllocationDonut.tsx` and `PerformanceChart.tsx`.
- Format helpers in `src/lib/format.ts` (`usd`, `pct`, `trendColor`).
- Theme bootstrap: inline script in `index.html` sets `dark` class before React mounts.
