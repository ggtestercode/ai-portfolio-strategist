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

## Deployment

**Always use `./deploy.sh` — never manual ssh one-liners.**

```bash
# From local machine:
cd /Users/zhiqitzq/ai-portfolio-strategist
./deploy.sh
```

**Never use:**
```bash
ssh root@139.180.215.150 "cd /root/ai-portfolio-strategist && git pull && pm2 restart trading-bot-api"
```
This skips the build step. The bot runs from a compiled `dist/index.mjs` (gitignored). Without `pnpm build`, `git pull` updates TypeScript source but the server keeps running the old binary — all code changes are silently invisible at runtime.

**Fast equivalent (skips frontend/schema, just rebuilds bot):**
```bash
ssh root@139.180.215.150 "cd /root/ai-portfolio-strategist && git pull && cd artifacts/api-server && pnpm build && cd /root/ai-portfolio-strategist && pm2 restart trading-bot-api"
```

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
- DB schemas in `lib/db/src/schema/`: `profile`, `holdings`, `targetAllocations`, `tradeSuggestions`, `transactions`, `riskAlerts`, `assistantMessages`, `strategyOptions`.
- Routes in `artifacts/api-server/src/routes/`: `user`, `goals`, `strategy`, `portfolio`, `performance`, `trades`, `rebalancing`, `transactions`, `alerts`, `assistant`, `dashboard`, all mounted under `/api`.
- Helper libs: `profile.ts`, `portfolio.ts`, `performance.ts`, `aiResponder.ts`, `strategyGenerator.ts`.
- Seed: `artifacts/api-server/src/seed.ts`. To run: bundle with esbuild and execute `node dist/seed.mjs`.

### LLM Integration
Uses `@workspace/integrations-openai-ai-server` (Replit-hosted OpenAI proxy). Model: `gpt-5.4`, chat completions, no temperature, `max_completion_tokens: 8192`.
- `aiResponder.generateAssistantReply()` powers `/api/assistant/messages` and `/api/command`. Builds a system prompt with live profile, allocation, and rebalancing context.
- `strategyGenerator.generateStrategyOptions()` uses `response_format: json_schema` to return 3 strict portfolio options (Low/Medium/High risk, 5–8 picks each with real tickers, weights summing to 100, and a one-sentence rationale per pick). Falls back to a deterministic 3-option set on failure.

### Strategy Options & Mix-and-Match
- `POST /api/strategy/regenerate` calls the LLM, replaces rows in `strategy_options`, picks the option matching the user's stated risk tolerance, aggregates picks by asset class to update `target_allocations`, and returns `{ strategy, options[] }`.
- `GET /api/strategy/options` returns the latest 3 options.
- `POST /api/strategy/options/apply` accepts `{ strategyName, picks[] }`, normalizes weights to 100%, aggregates by asset class, classifies risk by Crypto/Cash concentration, and updates the active strategy.
- UI: `components/StrategyOptions.tsx` on the Goals page renders 3 option cards. Users can "Use entire option" or check picks across cards; the bottom action bar shows selected count, combined weight, plan name, and applies the mix.

### Frontend
- React + Vite + TanStack Query + wouter + Tailwind (dark default via `localStorage('theme')`).
- Generated hooks via Orval in `lib/api-client-react`. Mutations take `{ data: { ... } }` for POST/PUT bodies; query invalidation uses `getXxxQueryKey()` helpers.
- Charts: Recharts via `components/charts/AllocationDonut.tsx` and `PerformanceChart.tsx`.
- Format helpers in `src/lib/format.ts` (`usd`, `pct`, `trendColor`).
- Theme bootstrap: inline script in `index.html` sets `dark` class before React mounts.
