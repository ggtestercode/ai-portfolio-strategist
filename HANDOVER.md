# AI Trading Bot — Project Handover
**Last updated:** May 30, 2026  
**Repo:** https://github.com/ggtestercode/ai-portfolio-strategist  
**Server:** Vultr Singapore — root@139.180.215.150  
**Deploy command:** `./deploy.sh` ← always use this, never manual ssh one-liners

---

## 1. Project Goals & Current Stage

**Goal:** AI-powered crypto trading bot using Claude as decision engine, operating with the judgment of an elite quantitative trader. Bot learns from every trade and self-improves over time.

**Current stage:** End-of-May observation period. A/B test running between Mode 3 (live Bybit) and Version B (paper). Decision on which approach to adopt for June with more capital pending end-of-month results.

**Exchange:** Bybit Live (real capital ~$21.82 after May 27–28 BTC crash)  
**Infrastructure:** PM2 on Vultr, Neon PostgreSQL (97.76/100 CU-hrs — near limit, resets June 1)  
**Telegram bot:** Polling mode, full command suite

---

## 2. Architecture

### 5-Layer Signal System (Mode 3)
1. **Market Regime Detection** — BTC ADX, DI+/-, ATR vs 30d avg
2. **Hard Filters** — extreme funding, HTF resistance, EMA misalignment, low liquidity; **no regime hard block** — Claude receives regime label in prompt and decides freely
3. **Weighted Scoring** — dynamic weights by regime, funding nonlinear, OI+price context, signal freshness decay
4. **Portfolio Allocator** — balance constraint only ($5 min per trade)
5. **Trade Manager** — Claude decides SL/TP structurally, exchange-level TP/SL, profit monitor

### Entry Gates (Mode 3) — as of May 27
- ~~TRENDING: 65 | RANGING: 70 | VOLATILE: 75 | CHOPPY/EXHAUSTION: 80~~ **Removed** (`179cd00`) — no score minimum by regime
- ~~Regime hard blocks (CHOPPY/EXHAUSTION/VOLATILE)~~ **Removed** (`3b6e5b6`, `d260ce0`) — Filter 1 gone entirely
- ~~regimeScoring per-regime entry instructions~~ **Removed** (`d1c16c9`) — "DO NOT enter" / "prefer longs" / "counter-trend scalps only" gone
- ~~scoringWeights point allocations and minimum score 65~~ **Removed** (`d1c16c9`) — Claude assigns score from own judgment
- ~~Score→recommendation mapping (≥80=STRONG BUY etc.)~~ **Removed** (`d1c16c9`) — Claude sets conviction/recommendation freely
- **Hard gate** (still enforced): `stopLoss`, `tp1`, `setupType`, `score` all must be present — score has no minimum value
- **Infrastructure filters** (still enforced): extreme funding >0.1%, HTF boundary, EMA alignment, liquidity <$10M
- **signalTruthTable retained**: direction-aware market knowledge (RSI, funding, OI, support/resistance context)
- Claude receives regime label + full market data and decides freely — no code-level or prompt-level scoring formula

### Exit System
- TP1: close 30%, SL → breakeven, set `tp1Executed=true`
- TP2: close 30% of original qty, set `tp2Executed=true`
- Large profit: ≥+15% close 50%; ≥+20% full close
- Hard stop: ≤-40% immediate
- Trailing SL: Claude-driven — optional `NEW_SL [$price]` on 3rd line of any HOLD/PARTIAL_CLOSE review; ratchet-only validation; replaces hardcoded 1.0×ATR trail (`ae059fc`)
- Daily loss limit: -30%
- Max stop loss: -40% from entry

### Position Review Rules
- Skip if: age < 4h AND P/L > -5% AND SL consumed < 30%
- CUT only if: loss ≤ -8%, opposing signal ≥ 80, or structural break >3× volume
- Entry context injected — review cannot contradict fresh entry without strong reason

### Version B (Paper Trading)
- No regime blocks, no score minimum
- Claude decides freely with portfolio review autonomy (HOLD/PARTIAL_CLOSE/CLOSE)
- Realistic cost simulation: 0.055% fees, 0.05–0.15% slippage, funding every 8h
- **No 48h auto-close** — trades run until SL hit, TP hit, or Claude portfolio review close
- No duplicate symbol+direction positions
- Balance constraint only ($5 min)

---

## 3. Learning System

### Trade Reflections (every Mode 3 close only)
- Model: Sonnet, maxTokens: 3,000
- **24 structured fields** including:
  - entryQuality, directionCorrect, entryTiming, slPlacement, tpRealism
  - entryCandleQuality, entryVolumeConfirmed
  - preTradeWarningsMissed, preTradeConfirmations
  - slWasCorrect, tpWasConservative, missedGainPct, continuedLossPct
  - candlePatternLesson, signalAccuracyInsight
  - versionBLesson, failureType, executionIssues
  - entryTimingVerdict, slTooTight, slTooWide
  - tp1Verdict, tp2Verdict, partialTiming
  - manualCloseVerdict, profitMissedPct
  - optimalEntryPrice, optimalSlPrice, optimalTp1Price, opportunityCostPct

**IMPORTANT: Version B does NOT generate reflections.** Paper trades are tracked in `paper_trades` table only. They do not write to `trade_memory`, do not influence rule generation, and do not feed signal accuracy history. Version B is fully isolated from the learning loop.

### Self-Improvement Rules (every 20 closed trades)
- 3 active rules (all HIGH confidence):
  1. Never enter without documenting signal+SL+TP+regime score
  2. STRONG_TREND entries require full confluence: RSI18 + ADX≥45 DI- dominant + funding
  3. Pre-define 3-tranche exits: 40%@TP1, 40%@TP2, trail 20%

### Version B Learning Gap (identified May 25)
Version B is fully isolated from the learning loop:
- No `generateReflection()` call when paper trades close
- No entry written to `trade_memory`
- `generateTradingRules()` queries `trade_memory WHERE action='TRADE_CLOSE'` — no source filter — but since Version B never writes there, it never influences rules
- Version B scan prompt does NOT inject `getActiveRules()` (imported but not called in `runPaperScan()`)
- Batch-5 verdict fields all null for Version B
- This means Version B scans without Mode 3's learned rules — the A/B test is not fully symmetric

---

## 4. Key Fixes Deployed (May 2026)

### Critical Execution Fixes (pre-May 24)
- **Stale metadata cache overwrite** — patchPositionMeta/patchEntrySource now invalidate cache before reading
- **WatchScan missing trade_log patch** — tp1/tp2/sl/atr now written as fallback
- **posMonitor self-heal** — auto-applies ATR SL/TP for missing metadata within 5 min
- **TP1/TP2 tier fix** — tp1Executed/tp2Executed flags track independently of tier count
- **Startup reconciliation** — on restart, compares open DB trades vs live Bybit; closes ghost positions
- **prevPositionSymbols seeding** — initialised from live Bybit on startup; SL hits detected mid-session
- **Direction verified from Bybit** — always uses `side` field from exchange, not inferred
- **fetchActualFillPrice()** — all 6 close paths use Bybit actual fill, not markPrice estimate
- **WatchScan dedup + conflict resolution** — no duplicate symbol+direction; direction flip requires approval

### Fixes Deployed May 24, 2026

**Telegram truncation (commit `46d9a8d`):**
- `/memory`, `/positions`, `/paperhistory` all now truncate at 3976 chars (sliced at last newline)
- Root cause: changes were applied to local file but never committed; `deploy.sh` does `git pull` first

**DB data integrity — entry price reconciliation (commit `976342b`):**
- `trade_log.entry_price` stored the planned limit price, not actual Bybit fill
- `trade_log.leverage` stored LLM-suggested value (sometimes 8×) not actual Bybit leverage (10×)
- Fix: post-fill both paths call `bybitGetPositions()` and update `trade_log` with actual avgPrice and leverage
- Backfill applied to all 6 open positions

**Liquidation price surfaced (commits `34f522b`, `56de232`):**
- `BybitPosition` interface now includes `liqPrice` from Bybit `/v5/position/list`
- Open positions in scan context show liquidation price
- Per-symbol scan prompt shows estimated liq at 10× leverage

**SL vs liquidation investigation + adjustments:**
- HYPEUSDT: $57.50 → **$58.30** | NEARUSDT: $2.22 → **$2.255** | ZECUSDT: $604 → **$608.00**

**OHLCV candles added (commit `97363b6`):**
- Last 20 × 1h and 20 × 15m per symbol injected into Phase 2 scan prompt
- Zero new API calls — reuses klines from `fetchMTFData()`

**`/forcerules` case fix (commit `9d8581a`):**
- Handler regex was `/^\/forceRules(?:@\w+)?$/` (case-sensitive) — Telegram sends lowercase `forcerules`
- Fixed with `i` flag: `/^\/forceRules(?:@\w+)?$/i`

---

## 5. Fixes Deployed May 25, 2026

### `/compare` command — multiple bugs found and fixed

**Bug 1 — TP1 count overcounting (commit `aa663d4`):**
- Old query: counted all `trade_memory WHERE tp1Reached=true AND createdAt >= May 24`
- Problem: `trade_memory.createdAt` is reflection time, not trade entry time. Trades opened before May 24 but reflected after showed up in count. Also any paper trade reflections would bleed in.
- Fix: `selectDistinct` joining `trade_log` + `trade_memory` by symbol with `entryAt >= since` as the anchor.

**Bug 2 — Net P&L missing minus sign (commit `aa663d4`):**
- `fmt()` was `${n >= 0 ? "+" : ""}$${Math.abs(n)}` — negatives showed as `$2.21` not `-$2.21`
- Fix: `${n >= 0 ? "+" : "-"}$${Math.abs(n)}`

**Bug 3 — Version B query wrong status filter (commit `41a08d5`):**
- Query: `WHERE status = 'closed'` — but paper trades close with status `tp1_hit`, `sl_hit`, `48h_timer`, `claude_close`, not just `closed`
- Fix: `ne(paperTradesTable.status, "open")` — match all non-open statuses

**Bug 4 — Symbol collision when same symbol traded twice (commit `67942f5`):**
- Old `selectDistinct(symbol, exitMethod, tp1Reached)` — if TIAUSDT traded twice, both trades collapsed to one row
- Also: join matched by symbol only (not time window), so TIAUSDT #2 picked up TIAUSDT #1's reflections
- Fix: raw SQL `DISTINCT ON (tl.id)` with 4h time window join: `tm.created_at BETWEEN tl.exit_at AND tl.exit_at + INTERVAL '4 hours'`
- Priority ordering: `sl_hit → tp% → review → other` ensures authoritative exit method selected per trade
- Now shows: `TP1: X | SL: Y | Review: Z (of N)`

**Bug 5 — Version B exit categories incomplete (commit `3be2c54`):**
- `claude_close` (portfolio review close) was not shown separately from `48h_timer`
- Version B exit reasons: `tp1_hit`, `sl_hit`, `claude_close`, `48h_timer`
- Now shows: `TP1: X | SL: X | Review: X | Timer: X (of N)`

### `/costs` command + cost logging improvements (commit `743d3d7`)

**Discovery:** `llm_usage_logs` table already existed and logged every call. Item 4 built on top of it.

**What was added:**
- `cache_write_tokens` column added to `llm_usage_logs` (was untracked — `cache_creation_input_tokens` from Anthropic response never captured)
- `COST_PER_M` updated with `cacheWrite` rates: Haiku $1.00/M, Sonnet $3.75/M, Opus $18.75/M
- `estimateCost()` now: `nonCached × input + cacheRead × cacheReadRate + cacheWrite × cacheWriteRate + output × outputRate`
- `/costs` Telegram command: today by caller, MTD total, top 3 most expensive callers, projected month-end

**`/costs` format:**
```
💰 Claude API Costs
Today (UTC)  $0.0423
  market_scan: $0.0210 (3×)
  trade_reflection: $0.0213 (2×)

Month-to-date  $1.2345
Daily avg: $0.0617 → Projected: $1.85

Top 3 MTD by caller:
  1. market_scan: $0.8210 (40×)
  2. trade_reflection: $0.2100 (10×)
  3. position_review: $0.0890 (89×)
```

### Scan prompt improvements (commit `b5a2d21`)

**Item 1 — Candles 20 → 50:**
- Both 1h and 15m extended from last 20 to last 50 candles per symbol
- No new API calls — `getKlines` already fetched 50; just removed `.slice(-20)` truncation
- +690 tokens/symbol, +6,900 tokens/scan

**Item 2 — Order book depth:**
- New `getOrderbook(symbol, limit=50)` in bybit.ts: `GET /v5/market/orderbook?category=linear&symbol=X&limit=50`
- Added to Phase 2 `Promise.all` per symbol (10 new API calls per scan)
- Format: `NEARUSDT Bids: 2.3500×50000,2.3490×30000,... Asks: 2.3510×45000,...`
- +330 tokens/symbol, +3,300 tokens/scan

**Item 3 — Funding rate history:**
- New `getFundingHistory(symbol, limit=24)` in bybit.ts: `GET /v5/market/funding/history?category=linear&symbol=X&limit=24`
- Returns array sorted oldest→newest (API returns newest-first; reversed)
- Format: `NEARUSDT funding hist (oldest→newest): +0.0100%,+0.0200%,-0.0050%,...`
- +53 tokens/symbol, +530 tokens/scan

**Combined cost impact:**
- +10,730 tokens/scan → +$0.032/scan
- 6 scans/day → **+$0.19/day → ~+$5.80/month**

---

## 6. A/B Test Status (as of May 27, 2026)

**Version B went live May 27** — regime thresholds removed (`179cd00`), Claude decides freely. No longer paper-only. Live capital running under Version B logic from May 27 onwards.

**First Version B live trade: TP1 hit +$0.85** (May 27)

### May 27 → now (Version B live baseline)
Track via `/compare` top section. Clean slate from regime-threshold removal.

### May 24–27 historical (A/B test period)

| Metric | Mode 3 (live) | Version B (paper) |
|---|---|---|
| Trades since May 24 | 3 | 1+ (NEARUSDT tp1_hit) |
| Win rate | 0% | growing |
| Net P/L | -$4.24 | growing |
| TP1 exits | 0 | 1 |
| SL exits | 1 (TIAUSDT) | 0 |
| Review closes | 2 (NEARUSDT, TIAUSDT #2) | growing |

**Mode 3 closed trades (May 24–27):**
- TIAUSDT #1 — SL hit, -$2.21, entry timing `early`, sl_too_tight, opportunity_cost_pct -12.25%
- NEARUSDT — Review close (posMonitor), -$0.62, tp1_reached=true but partial never fired
- TIAUSDT #2 — Review close (posMonitor), -$1.41

**TIAUSDT lessons recorded:**
- sl_too_tight appears in reflection — SL was hit but price quickly recovered
- TP1 was reached but partial never executed (limit order not staying active — root cause unresolved)
- Reflection captured; not yet crystallised into a trading rule (needs 3+ occurrences for rule generation)

**Current open positions (Mode 3):**

No open positions as of May 28. All remaining longs (ATOM/AVAX/TRX) were SL-hit overnight during BTC crash from ~$110k → $74k. Bot paused twice (daily loss limit May 27 23:43 UTC; peak drawdown -41.9% May 28 02:11 UTC). Bot resumed May 28, `peak_equity` reset to $21.82.

**Version B status:** Live from May 27. Do NOT close manually or reset balance.

---

## 7. Watchlist & Scan

### 27 Bybit Perpetuals
ADAUSDT APTUSDT ARBUSDT ATOMUSDT AVAXUSDT BCHUSDT BNBUSDT BTCUSDT DOGEUSDT DOTUSDT ETCUSDT ETHUSDT FTMUSDT HYPEUSDT INJUSDT LINKUSDT LTCUSDT MATICUSDT NEARUSDT OPUSDT SOLUSDT SUIUSDT TIAUSDT TRXUSDT XMRUSDT XRPUSDT ZECUSDT

### Scan Schedule
- Main scan: every 4h (`0 */4 * * *`)
- Watch list rescan: every 30 min after main scan

### What Claude Sees at Scan Time (Phase 2, per symbol) — as of May 25
- MTF summary: close + RSI for 1m/15m/1D; close + RSI + EMA20/50 for 1h/4h
- **Last 50 × 1h candles (OHLCV)** — extended from 20, May 25
- **Last 50 × 15m candles (OHLCV)** — extended from 20, May 25
- **Order book top 50 bids + 50 asks** — added May 25
- **24-period funding rate history** — added May 25
- Funding rate + OI (current)
- Estimated liquidation price at 10× leverage
- Relative strength vs BTC (4h/1D/7D avg)
- Liquidity sweep detection (last 10 candles)
- Squeeze detection (funding vs 50-period high/low)
- Table row: price, 7d%, 30d%, RSI, 24h volume
- Trade memory (last 5 reflections)
- Performance summary
- Active trading rules (3 rules, soft constraints)
- For open positions: entry, P/L, SL, TP, funding, key level, liqPrice
- **Recent exits (last 24h)** — per symbol: exit method (sl_hit/tp1/tp2/review close/profit protection/closed profitable/closed at loss), hours ago, price — added May 28

### Cost Summary
| Item | Cost |
|---|---|
| Vultr server | ~$6/month |
| Anthropic API | ~$22-25/month base + ~$5.80 for new scan data |
| Neon DB | Free tier (resets June 1) |
| **Total** | **~$34-37/month** |

---

## 8. Telegram Commands

| Command | Type | Cost |
|---|---|---|
| `/positions` | Live Bybit API | Free |
| `/history` | Bybit closed-pnl (last 10, compact) | Free |
| `/balance` | Live Bybit wallet | Free |
| `/status` | Live Bybit + DB regime | Free |
| `/paperhistory` | DB + live prices | Free |
| `/watchlist` | DB + next rescan time | Free |
| `/memory` | DB trade_memory | Free |
| `/rules` | DB trading_rules | Free |
| `/compare` | Mode 3 vs Version B stats (May 24→now) | Free |
| `/costs` | Claude API spend — today, MTD, top callers, projection | Free |
| `/autoscan now` | Triggers Claude scan | ~$0.09 |
| `/forceRules` | Triggers rule generation | ~$0.05 |
| `/closedust` | Closes tiny positions | Free |
| `/resume` | Resumes after daily limit | Free |
| NL messages | Claude API | ~$0.01-0.03 |

All long-output commands (`/memory`, `/positions`, `/paperhistory`) truncated at 3976 chars.

---

## 6. Fixes Deployed May 27, 2026

### All regime hard blocks removed from `applyHardFilters()` — Claude decides freely (commits `3b6e5b6`, `d260ce0`)

**Root cause:** `applyHardFilters()` lines 291–298 had a per-symbol hard veto for `CHOPPY`, `EXHAUSTION`, and `VOLATILE` regimes. Combined with the score threshold removal (`179cd00`), CHOPPY/EXHAUSTION was still vetoing every signal before Claude could evaluate it.

**Fix (two steps):**
1. `3b6e5b6` — Removed `CHOPPY` and `EXHAUSTION` from Filter 1; kept `VOLATILE`
2. `d260ce0` — Removed `VOLATILE` entirely; Filter 1 gone; no regime hard-blocks any entries in code

**Rationale:**
- Claude receives regime label in scan prompt — it can weigh it against structural quality, order book, candles, and SL placement
- Infrastructure-only filters kept: extreme funding (exchange risk), HTF boundary, EMA alignment, liquidity < $10M
- Regime is a judgment call — code should not override Claude's signal evaluation regardless of regime label
- VOLATILE in particular: if Claude sees a clean structural setup with tight SL above liq, it can enter; if it sees noise, it won't

**Result:** `applyHardFilters()` has no regime filter. All regimes pass through to Claude. Only infrastructure constraints remain.

---

### Regime score thresholds removed from cron scan (commit `179cd00`)

**Root cause:** After b5a2d21 deployed (May 25 13:57 UTC), the market regime was CHOPPY. The hard gate required score ≥ 80 for CHOPPY. No signals reached 80. Result: 0 new Mode 3 entries for the entire 2.5-day window from May 25 16:00 UTC → May 27. Claude was generating signals and assigning scores but every single one was blocked before the hard gate was even reached.

**Fix:** Removed the `score < execThreshold` pre-filter from `runCronScan()` in `cronScanner.ts`.
- `getRegimeThreshold()` in `marketScanner.ts` is retained (WatchScan still uses it; watchlist display uses it)
- Hard gate unchanged: `stopLoss`, `tp1`, `setupType`, `score` all still required — score just has no minimum value
- Claude's own judgment on whether the score justifies entry is now the sole gate
- Watchlist near-threshold concept removed — only explicit `WATCH` recommendations go to watch list now
- Telegram scan summary updated: "need X" / "above threshold" language removed

### `exitMethod` labeling — explicit exit reasons across all close paths (commit `276c7f7`)

**Root cause:** `generateReflection()` derived `exitMethod` from P&L percentage: `pnlPct < -5 → "sl_hit"`, else `"review"`. This mislabeled posMonitor review closes at -7% as `sl_hit`, and tight SL hits at -3% as `review`. The reflection prompt uses `exitMethod` to ask "Was SL hit?", assess manual close quality, and guide Claude's self-assessment — wrong labels corrupt the learning loop.

**Fix — 3 changes in `tradeMemoryLib.ts`:**
- `ReflectionInput` interface: added `exitReasonOverride?: string` — explicit label that overrides heuristic
- `generateReflection()`: `exitReasonOverride` takes priority; P&L heuristic is now the last resort fallback only
- `closeOpenTrade()`: added `exitReason?: string` param, forwarded as `exitReasonOverride` into `generateReflection()`

**7 call sites in `cronScanner.ts` now pass explicit reasons:**

| Call site | `exitReason` |
|-----------|-------------|
| 48h timer review CLOSE | `"review"` |
| Scan CUT decision | `"review"` |
| Position disappeared (exchange SL/TP/liq) | `closedPnl >= 0 ? "tp_hit" : "sl_hit"` |
| Large profit full close (≥20%) | `"profit_protection"` |
| Hard stop (−40%) | `"sl_hit"` |
| posMonitor Claude CLOSE | `"review"` |
| posMonitor dust → full close | `"review"` |

---

## 6. Fixes Deployed May 28, 2026

### Recent exit context added to Phase 2 scan prompt (commit `b77010e`)

Per-symbol: last 24h exits from `trade_log` joined with `trade_memory`. Shows exit method (sl_hit / tp1 / tp2 / review close / profit protection / closed profitable / closed at loss), hours ago, and price. Injected after liqLines in Phase 2 prompt so Claude can factor in recent re-entry risk. Fallback: `pnl > 0 → "closed profitable"`, `pnl ≤ 0 → "closed at loss"` when exit_method unavailable.

---

### Position limit: max 3 open positions (commit `46dbd03`)

Added to `cronScanner.ts` before the new-entry loop. Fetches live Bybit position count (`bybitGetPositions()`) before opening any position. If `openCountNow >= 3`, skips all new entries for that scan. Inside the loop: breaks early if `openCountNow + openedThisScan >= 3`. `openedThisScan` counter increments on each successful `gateResult.action === "executed"`. Infrastructure-only — no strategy logic. Capital preservation at $21 balance.

---

### `resumeTrading()` resets `peak_equity` to current balance (commit `59969de`)

**Root cause:** After peak drawdown halt fires, `/resume` cleared `trading_paused` but left `peak_equity` at the historical high. Next scan immediately re-evaluated drawdown vs the old peak → re-triggered the halt → infinite loop. May 28 08:00 UTC cron scan ran but produced no Phase 1/Phase 2 output for this reason.

**Fix:** `resumeTrading()` now calls `syncTotalCapitalToDB()` to fetch live Bybit balance, then writes `peakEquity: currentBalance` alongside clearing `tradingPaused`. Drawdown is measured from the new post-resume baseline, not the pre-crash peak.

**Immediate DB fix:** `peak_equity` manually set to `21.82` on May 28 09:51 UTC to unblock the 12:00 UTC scan.

---

### `/resume` resets daily P&L window via `resume_at` timestamp (commit `3a08669`)

**Root cause:** After the BTC crash, the daily loss limit (-30%) fired on top of the peak drawdown halt. `/resume` cleared `trading_paused` but `getDailyPnl()` still counted all of today's losses (ATOM/AVAX/TRX SL hits = -$13.60, 62% of balance). Every subsequent scan re-triggered the daily loss halt immediately — same infinite loop pattern as the `peak_equity` issue.

**Fix — 3 changes:**
- `botState` schema: added `resume_at TIMESTAMPTZ` column
- `resumeTrading()`: writes `resumeAt = NOW()` alongside `peakEquity` reset and `tradingPaused = false` — one atomic resume clears both limits
- `getDailyPnl()`: window is now `MAX(today 00:00 UTC, resume_at)` — pre-resume losses are excluded from the daily loss check; only trades closed after the last `/resume` count

**Result:** `/resume` is now a genuine clean slate for both risk checks. Future `/resume` calls always self-heal peak drawdown and daily loss simultaneously.

**DB applied:** `resume_at` column added via `ALTER TABLE`; `resume_at = 2026-05-28 12:07 UTC`, `trading_paused = false` set directly — bot resumed clean at 12:07 UTC May 28.

---

## 6. Fixes Deployed May 26, 2026

### INJUSDT TP2 miss investigation + three fixes (commit `5ba1ffc`)

**Root cause:** INJUSDT long (entry $5.157, TP1=$5.46, TP2=$5.78, size=10.9 units).
After TP1 fire + exchange partial limit order both executed simultaneously, position shrank to 1.2 units.
`originalQty` stayed at 10.9 in positionMeta → ratio 0.11 → tier=3 permanently.
`currentTier < 2` guard on TP2 blocked software partial for 3+ hours.
Trade closed by posMonitor 4h review at $5.779 (one cent below TP2). Exchange Full-mode TP ($5.78) never fired — review beat it. Reflection: `mistake=cut_winner_early`.

**Fix 1 — TP2 tier gate removed (`cronScanner.ts:631`):**
- Removed `currentTier < 2` from TP2 condition
- `!pm.tp2Executed` is now the sole gate, matching the TP1 pattern from 96c2b64
- Stale `originalQty` can no longer permanently block TP2

**Fix 2 — TP1 double-close prevention (`cronScanner.ts:602`):**
- `patchPositionMeta({ tp1Executed: true })` now runs **before** `closePercentPosition(30)`
- Exchange partial limit order at TP1 fires asynchronously; software also fires on same polling tick
- Setting flag first prevents subsequent cycles from double-closing; reduces over-reduction of position

**Fix 3 — TP1 verification log (`bybit.ts:307`):**
- Was reading `livePos.takeProfit` (= Full-mode TP2, e.g. $5.78) and logging "TP1 verified: $5.78" — wrong
- Now queries `orderFilter=tpslOrder` to find the actual partial conditional order by trigger price (±0.5%)
- Logs separately: "TP1 partial verified: qty=X at $Y" and "Position Full-mode TP (TP2): $Z"

---

## 7. Fixes Deployed May 29–31, 2026

### Limit order lifecycle — 4h cancel + fill detection + deferred SL/TP (commit `d5ae947`)

- **Stale limit orders cancelled after 4h** — `cancelStaleOrders()` threshold changed from 10 min → 4h. On cancellation: `trade_log` entry voided (`exitAt=now, pnl=0`, no LLM reflection), `pendingLimitFills` and `positionMeta` cleared. Symbol re-enters the scan naturally — `cancelStaleOrders()` runs before `runScan()` so the next Claude evaluation uses fresh market data. Telegram: `🚫 Limit order HYPE $71.50 cancelled — unfilled after 4h, re-evaluating`.

- **TP1/SL set after fill confirmation** — `openPosition()` no longer calls `trading-stop` for limit orders (position doesn't exist yet; was failing with `10001: zero position`). SL/TP full-mode on the order body still activates automatically when Bybit fills. Startup executor adds symbol to `pendingLimitFills` (in-memory map, exported from startup.ts) instead of calling `applyAtrSlTp`/`storePositionMeta`. posMonitor detects fill by checking each position against `prevPositionSymbols` — if symbol is new AND in `pendingLimitFills`: patches metadata with correct `openedAt=Date.now()`, calls `setTp1Partial()` on exchange, sends Telegram. `setTp1Partial` extracted as an exported function in `bybit.ts` (used by both market orders and limit fill handler).

- **Existing HYPE/BNB limit orders placed before this fix** — not in `pendingLimitFills` (map starts empty on restart). If they fill, Bybit applies SL/TP full-mode (set on order body); self-heal logic in posMonitor applies ATR SL/TP for missing metadata; TP1 partial may not be set but software polling in `checkPartialExits` handles TP1 as fallback.

**Post-investigation notes (live session):**

- **LINK TP1 "miss" — directional loss, not execution gap.** LINK was a limit order (pre-fix). TP1 exchange set failed with `10001` as expected. Limit filled at $9.030, price immediately dropped to SL $8.95, closed $8.986. TP1 at $9.18 was never reachable — price never went up. Reflection label `late_entry` is a mislabel; outcome was a clean directional loss with correct SL behaviour.

- **HYPE metadata collision — pre-d5ae947 artifact.** Two simultaneous HYPEUSDT positions: old (entry $65.953, TP2 $71.2) and new limit (entry $71.50, SL $69.8). Pre-fix `storePositionMeta` call on the new limit overwrote old HYPE's metadata in the shared `positionMetadata["HYPEUSDT"]` key. Startup `setSlTpForExistingPositions` detected old HYPE mark ~$69.3 vs stored SL $69.8 → "SL wrong side" → ATR reset → `34040: not modified`. d5ae947 fixes this: limit orders no longer call `storePositionMeta` at placement.

- **Old HYPE closed WIN +7.84% at TP2 cleanly.** Exit $71.188 against TP2 $71.2. Reflection: `mistake=cut_winner_early`.

---

### posMonitor — recent exit context, auto-execute, reformatted P/L (commit `baab6f0`)

- **Recent exit context in posMonitor** — before building the review prompt, queries `trade_memory` for the most recent `TRADE_CLOSE` record for the position's symbol in the last 24h. If found, injects a line like `Prior exit: INJUSDT sl_hit 8h ago at $6.542 (-2.1%)` into the position context block. Previously, Claude reviewing open positions had zero awareness of prior same-symbol losses — this was only injected in Phase 2 scan, not in posMonitor.

- **PARTIAL_CLOSE / CLOSE bypass approval gate** — removed `gateManualReview` call for CLOSE and PARTIAL_CLOSE decisions. These now execute immediately with a Telegram notification. The 15-min approval timeout was blocking time-sensitive profit protection (HYPE +3.5% PARTIAL_CLOSE was rejected by timeout → reverted to HOLD). HOLD and ADJUST_SL were never gated. New entries still route through the approval gate.

- **Position context reformatted** — P/L line now shows `Held: 35.2h | Peak P/L: +0.28% | Current P/L: -1.72% | Regime: CHOPPY` — both peak and current P/L are always explicit labels. Previously peak was a conditional parenthetical `(peak: +Y%)` only shown when drawdown from peak exceeded 0.1%.

---

### Recent exits query + limit order execution (commit `b2cfeb5`)

Both were silently broken since deployment — no errors surfaced, no visible impact until investigated.

- **Recent exits query fixed** — `ANY()` parameter bug in `marketScanner.ts`
  - Claude now sees "INJUSDT Recent: sl_hit 8h ago at $6.542" in every scan
  - Was silently failing since deployment; Claude had zero re-entry awareness
  - Root cause: Drizzle's `sql` template serializes JS arrays as a single bound param — Neon rejects it for `ANY()`. Fixed with `IN (sql.join(...))` so each symbol is its own `$N`.

- **Limit order execution fixed** — Claude's `limitPrice` now respected on Bybit
  - Falls back to market if limitPrice is absent or >2% from mark price
  - INJ example: planned $6.85 would now fill at $6.85, not $6.934
  - Root cause: `openPosition()` hardcoded `Market/IOC` — `limitPrice` was received and discarded. Fixed by threading `limitPrice` through `TradeProposal` → startup executor → `bybitOpen` opts → `Limit/GTC` order when within 2%.

---

### Mode 3 paper trading + /compare rewrite (commit `5bd9d9d`)

- **Version B paper disabled** — `PAPER_TRADING_ENABLED=false` in server .env
- **Mode 3 paper simulation active — zero extra API cost**
  - Uses Version B scan signals (`filteredSignals`) filtered by Mode 3 gates:
    CHOPPY/EXHAUSTION/VOLATILE hard block + `score >= getRegimeThreshold()`
  - Starting balance $40, tracked in `mode3PaperBalance` (new `bot_state` column; DB migrated on deploy)
  - Tagged `version='mode3'` in `paper_trades`; `updatePaperTradesPnl()` splits balance returns by version
  - 5-min paper monitor cron now always runs regardless of `PAPER_TRADING_ENABLED`
- **`/compare` rewritten** — Version B live vs Mode 3 paper, same time window (May 30 onwards); stale May 24-27 section dropped
- **Caveat:** Mode 3 paper uses Version B scan signals (unfiltered Claude judgment), not Mode 3's original structured prompt — partial simulation only; entry counts and signal mix differ from true Mode 3

---

### Claude-driven ratchet SL — replaces hardcoded ATR trail (commit `ae059fc`)

Removed 1.0×ATR trailing SL block from `checkPositionMonitor`. Claude outputs optional `NEW_SL [$price]` as 3rd line of any HOLD or PARTIAL_CLOSE decision. Ratchet-only validation (longs: newSl > currentSL; shorts: newSl < currentSL). Valid → `bybitSetStopLoss` + `patchPositionMeta`. CLOSE and ADJUST_SL skip the block.

---

### Peak unrealized P/L tracking (commit `7ef9295`)

Added `peakPnlPct` to `PositionMeta` (jsonb field, no migration). Updated on every posMonitor tick when `pnlPct` exceeds stored peak — one DB write per new high only. Claude review prompt now shows `P/L: +3.20% (peak: +6.80%)` when drawdown from peak exceeds 0.1%; omitted when position hasn't pulled back.

---

### Position review parse-fail alert + midnight summary (commit `043d6fb`)

**Parse-fail alert:** `makePositionReview` now checks `res.parseSuccess` after `llm.json()`. If false, sends Telegram: `⚠️ Position review parse failed — defaulting to HOLD for all positions`. Previously silent.

**Daily midnight SGT summary (00:00 SGT = 16:00 UTC):** Cron added to `startPositionMonitor`. No Claude API call — pure Bybit + DB. For each open position shows:
- Symbol, direction, entry price, current price
- P/L% with peak P/L% in brackets when drawdown from peak > 0.1%
- SL, TP1, held duration

Option A implemented (no last review decision). Option B (add `lastReviewDecision` to `PositionMeta`) deferred to post June 1.

---

### /history duration fix (commit `970d968`)

`durMs` was `lastCloseAt - firstCloseAt` (time between close events). For single-close trades this was always 0; for multi-partial trades it showed only the partial→final window. Fixed to `lastCloseAt - firstOpenedAt` using `openedAt` (Bybit `createdTime` = actual position entry timestamp), already present on every `BybitClosedPnl` record.

---

### TP1 double-close — third attempt (commit `e5a25bf`)

ATOM trade (entry May 28 $2.009, TP1=$2.10) triggered a double-close on May 29 ~00:05 UTC: `qty=7.4` and `qty=3.0` both closed at TP1. Investigation showed `5ba1ffc`'s "set flag before close" fix only addressed cron-tick vs cron-tick race (already prevented by `isScanning` guard anyway). Two paths remained:

1. `checkPartialExits` called from both `checkPositionMonitor` (5-min timer) and `runCronScan` (4h cron) with no shared lock — both could read `tp1Executed=false` before either wrote `true` (TOCTOU).
2. Exchange partial TP fires silently on Bybit with no code hook — `tp1Executed` never set by exchange-side fill, so software closes again on next poll.

**Fix 1 — Shared mutex (`cronScanner.ts`):**
- Added `partialExitRunning` boolean; `checkPartialExits` returns immediately if already running
- Prevents posMonitor and cronScanner concurrent calls from both seeing `tp1Executed=false`

**Fix 2 — Exchange TP1 silent detection (`cronScanner.ts`):**
- Before software TP1 check: if `pos.size < origQty × 0.85` and `!pm.tp1Executed`, exchange partial already fired
- Sets `tp1Executed=true` and updates local `pm` copy; software close skipped; TP2 gate still works this tick

**Fix 3 — Verification delay (`bybit.ts`):**
- Added 2000ms pause between `POST /v5/position/trading-stop` and verification `GET /v5/order/realtime`
- Bybit indexes the new order after the POST returns; immediate query consistently returned empty despite order existing and later firing — false-negative caused "software polling is the only fallback" log

---

### Claude-driven ratchet SL — replaces hardcoded ATR trail (commit `ae059fc`)

Removed the hardcoded `1.0×ATR` trailing SL block from `checkPositionMonitor`. Claude now controls SL updates directly via an optional `NEW_SL [$price]` line in any posMonitor review decision.

**How it works:**
- Claude may append `NEW_SL [$price]` as a 3rd line after any HOLD or PARTIAL_CLOSE decision
- Prompt instructs: only when in profit, ratchet only (longs: higher than current SL; shorts: lower than current SL)
- Code validates ratchet: longs require `newSl > currentSL`, shorts require `newSl < currentSL` (or currentSL unset)
- Valid → `bybitSetStopLoss` + `patchPositionMeta({ sl: newSl })`
- Invalid → warn log, no action
- CLOSE and ADJUST_SL decisions skip the `NEW_SL` block (CLOSE: position gone; ADJUST_SL: handles its own SL)
- `reason` parsing strips the `NEW_SL` line so it doesn't pollute Telegram reasoning text

**Rationale:** ATR-based trailing was blind to structure (support/resistance, key levels). Claude can place SL at meaningful levels rather than a fixed ATR multiple behind price.

---

## 8. Fixes Deployed June 1, 2026

### deploy.sh — git push + commit-hash verification (commit `d1e0a8d`)

- **Root cause identified:** deploy.sh never ran `git push`. It SSHed to the server and ran `git pull origin main` — so if local commits hadn't been pushed, the server pulled stale code and rebuilt the same old binary. `✅ Binary fresh` passed every time (binary age only, not content). 8 commits went undeployed silently across multiple sessions.
- **Fix 1 — git push before SSH:** `git push origin main` now runs first. If nothing to push or a conflict exists, the script halts before touching the server.
- **Fix 2 — commit-hash verification:** Local `HEAD` captured before SSH. After server pull+build, server `git rev-parse HEAD` compared against local hash. Mismatch → hard `exit 1` with explicit message. Binary age check removed entirely.

---

### generateTradingRules — full reflection coverage + force bypass (commits `d40210a`–`be9e4c7`)

- **Removed `LIMIT 60`** — generator now fetches all TRADE_CLOSE rows (was capping at 60, then filtering to ~37 strategy-only).
- **Removed execution filter** — all failure types now included; `failureType` field added to reflection format so Claude can distinguish them.
- **Rule count** — changed from hardcoded 5 to "between 5 and 15 — as many as evidence supports, minimum 3 occurrences each."
- **`force` parameter** — `generateTradingRules(force=false)`. `/forceRules` Telegram handler passes `force=true`, bypassing the 20-trade gate. Scheduled auto-check still gates normally.
- **DELETE + INSERT** — replaced upsert-on-ruleNumber with full delete then fresh insert. Old ghost rules from prior generations no longer persist if Claude returns fewer rules.
- **Raw response logged** — `[rules] Raw response: {json}` emitted before parsing so full Claude output is visible in PM2 logs.
- **Rate limit retry** — on 429 or usage-limit error: wait 60s, retry once. If still failing, Telegram: `⚠️ Rule generation rate-limited — try again in a few minutes`.
- **maxTokens raised to 8000** — was 1000 (too small for 15 detailed rules).

**Result:** First successful full-coverage run — 15 rules from 110 reflections, 60,397 input tokens, $0.24. Key finding: **exits are the primary P/L problem, not entries.** TP1 too_ambitious in 88/110 trades; avg opportunity cost 3.21% vs avg missed profit 1.90%. TRENDING_DOWN + long = 0% accuracy across 15+ instances (hard veto). Partial closes at/against entry price = primary P/L destroyer across 20+ trades.

---

## 9. Active Bugs & Open Issues

### Pending (not yet implemented)
- **Hard gate for SL/TP** — code enforcement (not just a rule) to reject any signal without SL, TP, and setupType. Agreed but not deployed. Rule 1 covers this as a soft constraint only.
- **Scan to 30min** — currently 4h for testing stability; restore when balance >$50 and stable
- **Trailing SL** — ✅ Claude-driven ratchet SL deployed (`ae059fc`); no longer hardcoded

### Known Constraints
- Neon DB at 97.76/100 CU-hrs — resets June 1; subscribe if it hits limit before then (~$3-5)
- Version B paper balance: ~$26-40 — do not reset
- HYPE and NEAR positions have no structural SL anchor above liquidation — slippage through SL cascades to liquidation

### Resolved May 28
- ✅ Recent exit context in Phase 2 scan prompt — last 24h per symbol: exit method, hours ago, price (`b77010e`)
- ✅ Position limit max 3 open — live Bybit count checked before every new entry; breaks early if limit hit mid-scan (`46dbd03`)
- ✅ `/resume` peak drawdown loop — `resumeTrading()` resets `peak_equity` to current live balance; drawdown measured from new baseline (`59969de`)
- ✅ `/resume` daily loss loop — `resume_at` timestamp added to `bot_state`; `getDailyPnl()` window = `MAX(today 00:00 UTC, resume_at)`; pre-resume losses excluded (`3a08669`)
- ✅ Bot resumed May 28 12:07 UTC — clean slate; `peak_equity = $21.82`, `resume_at = 12:07 UTC`; all positions were SL-hit in BTC crash

### Resolved May 27
- ✅ Leverage per-trade applied on Bybit (`af178d5`) — `openPosition()` now sets leverage from Claude's signal before placing order; safety cap: 10× maximum (silently clamped); conditional: skips `set-leverage` API call if current position leverage already matches
- ✅ All regime hard blocks removed from `applyHardFilters()` — Filter 1 gone entirely; CHOPPY/EXHAUSTION (`3b6e5b6`), VOLATILE (`d260ce0`); Claude receives regime in prompt and decides freely for all regimes
- ✅ Phase 2 scoring/regime instructions removed (`d1c16c9`) — regimeScoring, scoringWeights, score→recommendation mapping gone; funding/OI point values stripped to directional context only; Phase 1 systemContext simplified to free selection; Claude assigns score and conviction from own judgment
- ✅ Regime score thresholds blocking all cron entries — removed `score < execThreshold` pre-filter; Claude decides freely; hard gate (SL/TP/setupType/score present) unchanged (`179cd00`)
- ✅ `/compare` updated — new top section: Version B live (May 27 → now); historical May 24–27 below; 4-query parallel fetch, free (`be56090`)
- ✅ Version B went live May 27 — first trade: TP1 hit +$0.85, reflection confirmed firing
- ✅ `exitMethod` mislabeled in reflections — `exitReasonOverride` added to `ReflectionInput`; all 7 `closeOpenTrade()` call sites pass explicit reason; P&L heuristic is now fallback only (`276c7f7`)

### Resolved May 26
- ✅ TP2 permanently blocked by tier gate — `currentTier < 2` removed; `!pm.tp2Executed` is sole gate (`5ba1ffc`)
- ✅ TP1 double-close (exchange limit order + software both fire) — `tp1Executed` set before `closePercentPosition` (`5ba1ffc`)
- ✅ "TP1 verified on exchange: $5.78" misleading log — now checks partial conditional order separately from Full-mode TP2 (`5ba1ffc`)
- ✅ Version B portfolio review not executing closes — case-insensitive decision checks, JSON schema enum enforced, `position_review` Haiku→Sonnet 1500 tokens (`34548a6`)
- ✅ Version B portfolio review missing liquidation price — `Liq(est)=$X` added to position context line, calculated from entry price + 10× leverage, no API call (`d87fea2`)

### Resolved May 24–25
- ✅ Telegram "text is too long" errors — truncation applied
- ✅ DB entry_price storing planned price not actual fill — reconciliation post-fill
- ✅ DB leverage storing LLM value not actual Bybit — same fix
- ✅ Claude had no liquidation price visibility — now in prompt
- ✅ Claude had no OHLCV candle data — now sees 50 × 1h and 50 × 15m per symbol
- ✅ No order book depth — now included (top 50 bids/asks)
- ✅ No funding history — now included (24 periods)
- ✅ HYPE/NEAR/ZEC SLs dangerously close to liquidation — adjusted on Bybit
- ✅ `/forcerules` silently dropping command — case-insensitive regex fix
- ✅ `/compare` TP1 count overcounting — DISTINCT ON per trade with time window join
- ✅ `/compare` P&L sign missing minus — fmt() function fixed
- ✅ `/compare` Version B 0 trades — was filtering `status='closed'`, fixed to `ne(status,'open')`
- ✅ `/compare` symbol collision (same symbol twice) — raw SQL DISTINCT ON (tl.id)
- ✅ `/compare` exit breakdown incomplete — TP1 | SL | Review | Timer now shown
- ✅ `cache_write_tokens` untracked — now captured + cost formula corrected
- ✅ `/costs` command — live, queries existing `llm_usage_logs` table
- ✅ Version B learning gap — `generateReflection()` now fires on every Version B close with `source='version_b'` (`85492b9`)
- ✅ Version B rule injection — `getActiveRules()` now called in `runPaperScan()`; rules injected as soft context (`85492b9`)

---

## 10. Key Principles (Do Not Violate)

1. **Execution bugs → fix in code. Strategy decisions → Claude learns naturally.**
2. **Always use `./deploy.sh`** — never manual ssh one-liners (skips pnpm build, runs stale binary). Commit and push first — deploy.sh does `git pull` on the server.
3. **Bybit is source of truth for positions** — always use `pos.entryPrice`, `pos.leverage` from live API; never from DB trade_log
4. **DB trade_log is metadata, not source of truth** — both are now reconciled post-fill but still treat DB values as approximate
5. **Never suggest partial close at a loss** — SL exists to manage downside, let it work
6. **Do not add strategy rules** — let Claude discover through trade reflections and self-improvement
7. **Signal interpretation must be direction-aware** — RSI/funding mean opposite things for longs vs shorts
8. **Position review cannot contradict fresh entry** — entry context must be in review prompt
9. **SL must have meaningful gap above liquidation** — <1% gap is not protective
10. **No writing prompt during discussion** — discuss and confirm approach first
11. **Version B A/B test must not be interfered with** — no manual closes, no balance resets

---

## 11. Pre-Switch Checklist (before adopting Version B approach for live)

- [x] 48h auto-close removed from Version B — exits now via SL/TP/Claude review only (`acec8fb`)
- [x] Position age injected into review context — `Held: X.Xh` in posMonitor prompt (line 2157 cronScanner)
- [x] Hard gate active — SL/TP/setupType required before any entry in both cron and watchScan paths (`f398989`)
- [x] Entry price reconciled from Bybit after fill — actual avgPrice + leverage written to trade_log (`976342b`)
- [x] Liquidation price in scan prompt — per-symbol estimated liq + live liqPrice from Bybit (`34f522b`, `56de232`)
- [x] Order book, candle data, funding history in scan — top-50 book, 50 candles, 24-period history (`b5a2d21`)
- [ ] 5 clean trades closed — /compare reviewed before switching
- [x] Rules injected into Version B scan prompt (`85492b9`)
- [x] Reflections enabled on Version B closes (`85492b9`) — `source='version_b'` in trade_memory
- [ ] Credit balance topped up
- [x] Switch live capital to Version B logic — regime thresholds removed, Claude decides freely (`179cd00`)
- [ ] Keep Mode 3 as paper with fee/slippage simulation
- [x] Confirm first Version B live close triggers reflection correctly — TP1 hit +$0.85 (May 27)
- [ ] Rollback plan confirmed — Mode 3 config preserved

---

## 12. June 1 Action Plan

1. Neon resets → DB CU-hrs back to 0, full operation resumes automatically
2. Force rules regeneration from clean post-fix trades (`/forceRules`)
3. Deploy hard gate: SL/TP/setupType required before any entry (code enforcement, not just rule)
4. Evaluate A/B test results: if Version B sustained outperformance → adopt unconstrained Claude approach for live trading
5. ✅ Closed learning loop gap: `generateReflection()` fires on every Version B close with `source='version_b'`
6. ✅ Active rules injected into Version B scan for symmetric comparison
7. Consider adding more capital if performance confirmed
8. Restore scan to 30min when balance >$50 and stable
9. Review HYPE/NEAR positions — both have SL above liq but no structural anchor

---

## 13. Files & Key Locations

| File | Purpose |
|---|---|
| `artifacts/api-server/src/lib/cronScanner.ts` | Main 4h scan, position review, WatchScan, entry price reconciliation |
| `artifacts/api-server/src/lib/paperScanner.ts` | Version B paper trading (isolated from learning loop) |
| `artifacts/api-server/src/lib/tradeMemoryLib.ts` | Reflections, rules, learning loop, getDailyPnl |
| `artifacts/api-server/src/lib/marketScanner.ts` | Signal generation prompts, 50 OHLCV candles, order book, funding history |
| `artifacts/api-server/src/lib/llmRouter.ts` | Claude routing, cost calculation, logs to llm_usage_logs |
| `artifacts/api-server/src/lib/startup.ts` | Startup reconciliation, metadata healing |
| `artifacts/api-server/src/notifications/telegram.ts` | All Telegram commands including /compare, /costs |
| `artifacts/api-server/src/brokers/bybit.ts` | Exchange API — getOrderbook(), getFundingHistory(), liqPrice |
| `lib/db/src/schema/operation.ts` | llmUsageLogs table — includes cache_write_tokens |
| `deploy.sh` | **Always use this for deployment** |
| `.env` | BYBIT_TRADING_MODE=live, PAPER_TRADING_ENABLED=true |

### All Commits (May 24–25, 2026)
| Commit | Description |
|--------|-------------|
| `46d9a8d` | fix: truncate /memory, /positions, /paperhistory |
| `976342b` | fix: reconcile actual Bybit entryPrice + leverage into trade_log |
| `34f522b` | feat: surface liqPrice in scan position context |
| `56de232` | feat: estimated liq per symbol in scan prompt |
| `97363b6` | feat: last-20 1h + 15m OHLCV candles in scan prompt |
| `9d8581a` | fix: /forcerules case-insensitive regex |
| `56a1482` | docs: HANDOVER.md May 24 update |
| `aa663d4` | fix: /compare TP1 count + P&L sign |
| `41a08d5` | fix: /compare Version B status filter (ne open) |
| `67942f5` | fix: /compare DISTINCT ON per trade + review/timer counts |
| `3be2c54` | fix: /compare Version B add Review (claude_close) + Timer |
| `743d3d7` | feat: /costs command + cache_write_tokens + accurate cost calc |
| `b5a2d21` | feat: scan prompt — 50 candles, order book, funding history |
| `85492b9` | feat: Version B rules injection + reflections on every close; source='version_b' |
| `a65c1ee` | docs: mark rules injection + reflections done in pre-switch checklist |
| `5ba1ffc` | fix: TP2 tier gate, TP1 double-close prevention, TP1 verification log |
| `34548a6` | fix: Version B portfolio review — case-insensitive decisions, JSON schema enum, Sonnet 1500t |
| `d87fea2` | feat: Version B portfolio review — add Liq(est) from entry price + 10× leverage |
| `276c7f7` | fix: pass exitReason explicitly through closeOpenTrade → generateReflection (7 call sites) |
| `179cd00` | fix: remove regime score thresholds from cron scan entry gate |
| `be56090` | feat: /compare — Version B live baseline May 27 + historical May 24-27 |
| `2db0ba3` | docs: HANDOVER.md — Version B live May 27, /compare update, first TP1 +$0.85 |
| `0b89f1e` | fix: /compare live section queries trade_log not paper_trades |
| `3b6e5b6` | fix: remove CHOPPY/EXHAUSTION hard block from applyHardFilters(); keep VOLATILE |
| `d260ce0` | fix: remove VOLATILE hard block from applyHardFilters(); no regime blocks in code |
| `d1c16c9` | fix: remove regime/scoring instructions from Phase 2 prompt — Claude decides freely |
| `d8e5b89` | fix: simplify Phase 1 systemContext — free symbol selection, no RS/RSI rules |
| `af178d5` | fix: openPosition() — cap leverage at 10x; skip set-leverage if already set |
