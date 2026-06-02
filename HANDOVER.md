# AI Trading Bot — Handover
**Last updated:** June 2, 2026
**Full history:** HANDOVER_ARCHIVE.md and `git log --oneline`
**Repo:** https://github.com/ggtestercode/ai-portfolio-strategist
**Server:** Vultr Singapore — `root@139.180.215.150`
**Deploy:** `./deploy.sh` — always use this; never manual ssh. Pushes to origin first, verifies commit hash on server.

---

## Current State

- **Balance:** ~$26 | **Exchange:** Bybit Live | **Infra:** PM2 on Vultr, Neon PostgreSQL
- **Open positions:** HYPE long, INJ long, XRP short (check `/positions` for live state)
- **Scan:** every 4h (`0 */4 * * *`) | posMonitor: every 5 min
- **Learning rules:** 15 active (generated June 1 from 110 reflections — exits are the primary problem)
- **Neon DB:** reset June 1 ✅ — CU-hrs back to 0

---

## Architecture

### Signal Flow
1. **Phase 1 (Haiku)** — selects top 10 symbols by RS vs BTC from 27 watchlist symbols
2. **Phase 2 (Sonnet)** — per-symbol: MTF, 50 candles, order book, funding history, recent exits, pending orders → signal JSON
3. **Hard gates** — SL/TP1/setupType/score present; R:R ≥ 1.1 (computed from raw values); extreme funding >0.1%; HTF boundary; EMA alignment; liquidity <$10M
4. **Position limit** — max 3 open (live Bybit count before any new entry)
5. **posMonitor** — 5-min tick; Claude review every 4h (sooner at drawdown or RSI/OI triggers)

### Entry Signal Schema (key fields Claude returns)
`symbol, direction, score, entry, stopLoss, tp1, tp2, rewardRiskRatio (required), setupType, tp1ClosePercent (default 30), tp2ClosePercent (default 100), limitPrice`

### Exit System
- **TP1:** close `tp1ClosePercent`% (default 30%), SL → breakeven, set `tp1Executed=true`
- **TP2:** close `tp2ClosePercent`% of remaining (default 100% = Full-mode). If <100%, exchange sets Partial TP via `trading-stop`
- **Large profit:** ≥+15% close 50%; ≥+20% full close
- **Hard stop:** ≤-40% immediate | **Daily loss limit:** -30%
- **Trailing SL:** Claude outputs `NEW_SL [$price]` on 3rd line of any HOLD/PARTIAL_CLOSE (ratchet-only)

### Limit Order Flow
- Placed as Limit/GTC if `limitPrice` within 2% of mark price; falls back to Market/IOC
- `pendingLimitFills` map persisted to `bot_state.pending_limit_fills` — survives restarts
- On restart: `recoverPendingLimitFills()` re-applies `setTp1Partial` + `setTp2Partial` for live positions
- Stale orders cancelled after 4h by `cancelStaleOrders()`

### What Claude Sees at Scan Time (Phase 2, per symbol)
- MTF: close+RSI for 1m/15m/1D; close+RSI+EMA20/50 for 1h/4h
- Last 50 × 1h and 50 × 15m candles (OHLCV)
- Order book top 50 bids/asks
- 24-period funding rate history + current funding + OI
- Estimated liq price at 10× leverage
- Relative strength vs BTC (4h/1D/7D)
- Liquidity sweep + squeeze detection
- Trade memory (last reflections) + performance summary
- 15 active trading rules (soft constraints)
- Open positions: entry, P/L, SL, TP, peak P/L, liqPrice
- Recent exits (last 24h): exit method, hours ago, price
- **Pending limit orders** (unfilled): direction, price, qty, hours pending

### Learning System
- **Reflections:** Every close (Mode 3 + Version B) — 24 structured fields
- **Rules:** Generated every 20 trades from all reflections; `/forceRules` bypasses gate
- **Rule generation:** Claude reads all `trade_memory` TRADE_CLOSE rows; DELETE+INSERT (no stale rules)
- **Version B:** Fully symmetric — reflections fire on close, rules injected in prompt

---

## Recent Commits (last 15)
| Commit | Description |
|--------|-------------|
| `cb11b2f` | fix: getOrders logs+rethrows; recoverPendingLimitFills checks open orders |
| `70b2d2c` | fix: lower R:R hard gate from 1.5 to 1.1 — both scan paths |
| `ba3361d` | fix: raise R:R hard gate from 1.0 to 1.5 — both scan paths |
| `449b0fc` | docs: HANDOVER.md — tp1 enforcement fix details |
| `d3bfcf2` | fix: enforce tp1 > 0 — prompt + hard gate |
| `267b8f2` | docs: HANDOVER.md slim + archive |
| `6843be7` | feat: pending limit orders in Phase 2 scan prompt |
| `6db3bef` | docs: HANDOVER.md tp1/tp2ClosePercent |
| `68400c7` | feat: tp1ClosePercent/tp2ClosePercent — Claude controls exit sizing |
| `3bc2618` | docs: HANDOVER.md pendingLimitFills + TP exit structure |
| `1ef2339` | fix: pendingLimitFills persists to DB — survives restarts |
| `e624890` | docs: HANDOVER.md R:R hard gate |
| `f16b917` | feat: rewardRiskRatio field + 1:1 R:R hard gate (misreporting-proof) |
| `2dcc731` | docs: HANDOVER.md June 1 deploy.sh fix + rule generator |
| `d1e0a8d` | fix: deploy.sh — git push first + commit hash verification |
| `db87ae6` | fix: rule_generation maxTokens 8000 |
| `97b75f0` | fix: generateTradingRules — retry + logging |
| `be9e4c7` | fix: forceRules bypasses gate, DELETE+INSERT |
| `7417f71` | fix: generateTradingRules fresh generation each time |
| `5ed500b` | fix: generateTradingRules evidence-driven rule count (5–15) |

---

## Open Items
- **Scan to 30min** — currently 4h; restore when balance >$50 and stable
- **Capital top-up** — consider if performance confirmed
- **tp1 always required in signal** — fixed `d3bfcf2`: prompt hardened + gate uses `v <= 0` for numerics
- **Run `/forceRules`** after 5+ more clean trades — regenerate rules without corrupted reflection influence

## Investigation Finding — Reconciler Overwrite Bug (June 2)

**Root cause: reconciler stamps prior closed PnL onto pending limit order rows when a same-symbol position closes while the limit order is still unfilled.**

- On restart, `recoverPendingLimitFills()` cleared limit-order rows when no live position existed (treating unfilled = closed)
- Reconciler then called `bybitGetClosedPnl()` for that symbol → found the *previous* trade's exit data → wrote wrong entry/exit/pnl onto the pending row
- Two trades affected: **LINKUSDT** (a0f713d6) had -$1.63 loss overwritten onto what was a +$1.17 win; **HYPEUSDT** (384a9874) was phantom-closed with May 30 position's +$1.498 PnL while the Jun 1 $71.50 fill is still open
- Two corrupted reflections in `trade_memory` deleted (LINK `-3.03%` and HYPE `+7.84%`, both created Jun 1 00:24 UTC)

**Fixed in `cb11b2f`:** `recoverPendingLimitFills()` now checks for open orders on Bybit before removing a fill entry — only removes when both no live position AND no open order exist.

**DB corrections applied June 2:**
- `a0f713d6` LINKUSDT: entry $9.253→$9.030, exit $8.986→$9.189, pnl -$1.63→+$1.17, pnl_pct -3.03%→+1.72%
- `384a9874` HYPEUSDT: entry $65.953→$71.50, exit_at/exit_price/pnl cleared (position still open)

## Investigation Finding — SOLUSDT (June 2)

**Root cause: limit orders without `tp1` in the signal skip `setTp1Partial` entirely.**

- `pendingLimitFills` stores `tp1: undefined` when signal has no `tp1Price`
- Fill detection condition `fill.tp1 && fill.tp1 > 0` → FALSE → `setTp1Partial` never called
- ATR self-heal fires instead → sets Full-mode TP via `bybitSetTakeProfit()` (not a partial)
- **Self-heal ATR TP can be wrong-side on shorts:** if metadata is stale or position qty changed, the ATR calculation uses wrong `entryPrice` and places TP above entry for a short (loss direction, not profit direction)
- SOL closed via posMonitor CLOSE (restart cleared `lastReviewAt` → immediate review) not exchange TP

**Fixed in `d3bfcf2` / `449b0fc`:**
- `tp1` required field instruction added to Phase 2 scan prompt — explicit note that `tp1=0` is rejected and must be a specific price matching trade direction
- Hard gate `tp1`/`stopLoss` check hardened from falsy `!v` to explicit `typeof v === 'number' ? v <= 0 : !v` — catches zero and negative prices by name
- Prevents `setTp1Partial` being skipped on limit fills (root cause: `pendingLimitFills.tp1 = undefined` when signal omits or zeros `tp1`)

---

## Key Principles
1. **Execution bugs → fix in code. Strategy → Claude learns naturally.**
2. **Always use `./deploy.sh`** — commit and push first; deploy.sh runs `git pull` on server.
3. **Bybit is source of truth for positions** — use `pos.entryPrice`, `pos.leverage` from live API.
4. **Never suggest partial close at a loss** — let SL do its job.
5. **Do not add strategy rules** — Claude discovers through reflections.
6. **Signal interpretation must be direction-aware** — RSI/funding mean opposite things long vs short.
7. **Position review cannot contradict fresh entry** without strong structural reason.
8. **SL must have meaningful gap above liquidation** — <1% gap is not protective.
9. **Discuss before implementing** — no code without confirmation on strategy changes.
10. **Version B must not be interfered with** — no manual closes, no balance resets.

---

## Files & Key Locations
| File | Purpose |
|---|---|
| `artifacts/api-server/src/lib/cronScanner.ts` | Main 4h scan, posMonitor, WatchScan, TP/SL logic |
| `artifacts/api-server/src/lib/marketScanner.ts` | Phase 1/2 prompts, signal schema, pending orders |
| `artifacts/api-server/src/lib/paperScanner.ts` | Version B paper trading |
| `artifacts/api-server/src/lib/tradeMemoryLib.ts` | Reflections, rules, getDailyPnl |
| `artifacts/api-server/src/lib/startup.ts` | Executor, pendingLimitFills, startup reconciliation |
| `artifacts/api-server/src/brokers/bybit.ts` | Exchange API — all Bybit calls |
| `artifacts/api-server/src/notifications/telegram.ts` | All Telegram commands |
| `lib/db/src/schema/botState.ts` | PositionMeta, PendingLimitFill interfaces |
| `deploy.sh` | **Always use this** |

## Telegram Commands
`/positions` `/balance` `/history` `/status` — free, live Bybit
`/memory` `/rules` `/compare` `/costs` `/watchlist` — free, DB
`/autoscan now` ~$0.09 | `/forceRules` ~$0.05 | NL messages ~$0.01–0.03
All long-output commands truncated at 3976 chars.

## Cost Summary
Vultr ~$6/mo | Anthropic API ~$28–32/mo | Neon DB free tier | **Total ~$34–38/mo**
