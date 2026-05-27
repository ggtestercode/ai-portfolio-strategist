# AI Trading Bot — Project Handover
**Last updated:** May 25, 2026  
**Repo:** https://github.com/ggtestercode/ai-portfolio-strategist  
**Server:** Vultr Singapore — root@139.180.215.150  
**Deploy command:** `./deploy.sh` ← always use this, never manual ssh one-liners

---

## 1. Project Goals & Current Stage

**Goal:** AI-powered crypto trading bot using Claude as decision engine, operating with the judgment of an elite quantitative trader. Bot learns from every trade and self-improves over time.

**Current stage:** End-of-May observation period. A/B test running between Mode 3 (live Bybit) and Version B (paper). Decision on which approach to adopt for June with more capital pending end-of-month results.

**Exchange:** Bybit Live (real capital ~$36)  
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

### Entry Score Thresholds (Mode 3)
- ~~TRENDING: 65 | RANGING: 70 | VOLATILE: 75 | CHOPPY/EXHAUSTION: 80~~ **Removed May 27** — Claude decides freely
- Score is still required by hard gate (any value) but no minimum blocks entry by regime
- Removal reason: CHOPPY threshold (80) blocked all entries for 2.5 days post-b5a2d21 despite valid signals

### Exit System
- TP1: close 30%, SL → breakeven, set `tp1Executed=true`
- TP2: close 30% of original qty, set `tp2Executed=true`
- Large profit: ≥+15% close 50%; ≥+20% full close
- Hard stop: ≤-40% immediate
- Trailing SL: activates at +3% P/L, distance 1.0× 4h ATR, ratchets protectively
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

| Symbol | Dir | Entry | SL | Liq | Lev |
|--------|-----|-------|----|-----|-----|
| NEARUSDT | long | $2.3949 | $2.255 | $2.1772 | 10× |
| HYPEUSDT | long | $62.869 | $58.30 | $56.964 | 10× |
| ZECUSDT | long | $646.41 | $608.00 | $593.65 | 10× |
| BCHUSDT | short | $352.50 | $369.50 | $383.90 | 10× |
| INJUSDT | long | $5.157 | $4.970 | $4.689 | 10× |

Note: TIAUSDT closed. HYPE and NEAR still have SL above liq but no structural anchor below liq.

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
2. `pending` — Removed `VOLATILE` entirely; Filter 1 gone; no regime hard-blocks any entries in code

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

## 9. Active Bugs & Open Issues

### Pending (not yet implemented)
- **Hard gate for SL/TP** — code enforcement (not just a rule) to reject any signal without SL, TP, and setupType. Agreed but not deployed. Rule 1 covers this as a soft constraint only.
- **Scan to 30min** — currently 4h for testing stability; restore when balance >$50 and stable

### Known Constraints
- Neon DB at 97.76/100 CU-hrs — resets June 1; subscribe if it hits limit before then (~$3-5)
- Version B paper balance: ~$26-40 — do not reset
- HYPE and NEAR positions have no structural SL anchor above liquidation — slippage through SL cascades to liquidation

### Resolved May 27
- ✅ All regime hard blocks removed from `applyHardFilters()` — Filter 1 gone entirely; CHOPPY/EXHAUSTION (`3b6e5b6`), VOLATILE (`d260ce0`); Claude receives regime in prompt and decides freely for all regimes
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
