# AI Trading Bot — Project Handover
**Last updated:** May 24, 2026  
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
2. **Hard Filters** — extreme funding, HTF resistance, EMA misalignment, low liquidity
3. **Weighted Scoring** — dynamic weights by regime, funding nonlinear, OI+price context, signal freshness decay
4. **Portfolio Allocator** — balance constraint only ($5 min per trade)
5. **Trade Manager** — Claude decides SL/TP structurally, exchange-level TP/SL, profit monitor

### Entry Score Thresholds (Mode 3)
- TRENDING: 65 | RANGING: 70 | VOLATILE: 75 | CHOPPY/EXHAUSTION: 80

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
- 48h auto-close for stale positions
- No duplicate symbol+direction positions
- Balance constraint only ($5 min)

---

## 3. Learning System

### Trade Reflections (every close)
- Model: Sonnet, maxTokens: 2,000
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

### Pre/Post Candle Analysis (in every reflection)
- Pre-trade: 1h × 12 candles (12h trend) + 15m × 8 candles (2h before entry) + BTC context
- Entry candle: 1h + 15m — body/wick ratio, volume, HH/HL/LH/LL pattern, pin bars, doji
- Post-trade: 1h × 24 candles (24h) + 15m × 8 candles (2h after exit) + BTC context
- Re-examines candles with hindsight for missed signals

### Signal Accuracy Tracking
- Per-signal win rate accumulated across all trades
- Fed into every scan: "Your signal accuracy history: sweep 75%, RS vs BTC 33%..."

### Self-Improvement Rules (every 20 closed trades)
- 3 active rules (all HIGH confidence):
  1. Never enter without documenting signal+SL+TP+regime score
  2. STRONG_TREND entries require full confluence: RSI18 + ADX≥45 DI- dominant + funding
  3. Pre-define 3-tranche exits: 40%@TP1, 40%@TP2, trail 20%
- Rule tracking now uses per-trade `appliedRuleIds` — Rule 2 only tagged on STRONG_TREND shorts
- Old win/loss counts (7W/5L identical across all rules) were contaminated by a bug; reset to 0

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

### Signal Interpretation Fixes (pre-May 24)
- **Direction-aware signal truth table** — RSI/funding/EMA interpreted relative to position direction:
  - SHORT + RSI < 30 = price dropping = GOOD (not "bounce risk")
  - SHORT + funding negative = squeeze risk (not "bearish confirmation")
  - Funding positive = longs crowded = GOOD for shorts
- **Applied to all three prompts:** makePositionReview, runPositionReview, marketScanner

### Fixes Deployed May 24, 2026

**Telegram / infrastructure (commit `46d9a8d`):**
- `/memory`, `/positions`, `/paperhistory` all now truncate at 3976 chars (sliced at last newline)
- Previously caused `400 Bad Request: text is too long` — unguarded `sendMessage` calls
- Root cause: changes were applied to local file but never committed; `deploy.sh` does `git pull` first so the server never received them

**DB data integrity — entry price reconciliation (commit `976342b`):**
- **Bug found:** `trade_log.entry_price` stored the *planned limit price* from the scan signal, not the actual Bybit fill price. `trade_log.leverage` stored the LLM-suggested leverage (sometimes 8×) not the actual Bybit account leverage (10×).
- **Fix:** After every order fill, both cron scan and watch scan paths now call `bybitGetPositions()`, find the live position, and update `trade_log` with actual `avgPrice` and `leverage`.
- **Backfill applied:** All 6 open positions corrected immediately via direct DB update.
- **Downstream impact confirmed:** Live trading logic was unaffected (all monitors read from Bybit API, not DB). The reflection system was the most exposed — SL/TP distance % calculations and entry timing verdicts used the wrong baseline price.

| Symbol | Old entry (DB) | Actual fill | Old lev | Fixed lev |
|--------|----------------|-------------|---------|-----------|
| ZECUSDT | $642.00 | $646.41 | 8× | 10× |
| HYPEUSDT | $62.00 | $62.87 | 8× | 10× |
| NEARUSDT | $2.38 | $2.3949 | 10× | 10× |
| TIAUSDT | $0.425 | $0.4274 | 10× | 10× |
| BCHUSDT | $358.00 | $352.50 | 8× | 10× |
| INJUSDT | $5.14 | $5.157 | 10× | 10× |

**Liquidation price surfaced to Claude (commits `34f522b`, `56de232`):**
- `BybitPosition` interface now includes `liqPrice` (fetched from Bybit's `/v5/position/list` `liqPrice` field)
- Open positions in scan context now show: `Liquidation=$56.9640`
- Per-symbol scan prompt now shows: `NEARUSDT liq@10x: long=$2.1690 short=$2.6510`
- Claude uses this to self-assess SL placement without being told to

**SL vs liquidation investigation + adjustment:**
- Investigation found 3 open positions had SL dangerously close to liquidation:
  - HYPEUSDT: SL $57.50 vs liq $56.964 — gap only $0.536 (0.9%) — ALL swing lows below liq
  - NEARUSDT: SL $2.22 vs liq $2.1772 — gap only $0.043 (1.8%) — EMA20 below liq
  - ZECUSDT: SL $604 vs liq $593.65 — gap only $10.35 (0.37× ATR)
- Claude one-off assessment run; proposed structural SLs confirmed
- SLs updated on Bybit and synced to DB:
  - HYPEUSDT: $57.50 → **$58.30** (above EMA20 $57.998)
  - NEARUSDT: $2.22 → **$2.255** (liq buffer logic; no usable structure above liq)
  - ZECUSDT: $604 → **$608.00** (above EMA50 $600.87, which sits above liq $593.65)

**OHLCV candles added to scan prompt (commit `97363b6`):**
- `fetchMTFData()` refactored to return raw `klines1h` and `klines15m` alongside the summary string
- Last 20 × 1h candles and last 20 × 15m candles now injected into Phase 2 scan prompt per symbol
- Format: `NEARUSDT 1h candles (O,H,L,C,V): 2.3980,2.4120,2.3890,2.4010,923451 | ...`
- Zero new API calls — reuses klines already fetched inside `fetchMTFData`
- Claude can now see candle bodies, wicks, and volume bars for pattern detection
- Cost increase: ~4,100 additional input tokens per scan (~$0.012/scan, ~$2.20/month)

---

## 5. Signal Contradiction Report (62 Trades)

### Reliable Signals (never fail)
1. HYPE RS +8%+ vs BTC → long direction (100% directional accuracy)
2. BCH negative RS vs BTC → short
3. Trade memory 5+ profitable shorts at level → OP shorts
4. ADX 46+ DI- dominant → STRONG_TREND confirmation
5. Correct SL placement (never cited in failures)
6. Liquidity sweep 2.0–2.3× wick/body + volume

### Reliably Bad (0% win rate)
1. LONG in TRENDING_DOWN — 1W/8L = 11%
2. No SL defined — 0% across 30+ trades
3. No TP1/TP2 defined — 0% across 30+ trades
4. Undocumented NL entries — 0% across 6 trades
5. Long at resistance without breakout confirmation
6. Short entered on strong bullish candle body (55-95%)
7. Short against 15m HH/HL structure

### Contradicted Signals (no edge)
1. TRENDING_DOWN regime label — survivorship credited on wins, blamed on losses
2. Rising volume alone — means opposite things depending on RS context
3. BTC alignment — credited both ways
4. RSI extreme — used to justify both reversal and continuation simultaneously

### Key Insight
"Rising volume" has no standalone meaning. Its interpretation depends entirely on RS vs BTC:
- BCH RS -4.8% + rising volume = supply pressure (bearish) ✅
- HYPE RS +8.1% + rising volume = accumulation (bullish) ✅
Signal should be: "RS-adjusted volume" not "rising volume."

---

## 6. A/B Test Status (as of May 24, 2026)

| Metric | Mode 3 (live) | Version B (paper) |
|---|---|---|
| Win rate | 50% | 69% |
| Net P/L | ~+$4-6 real | +$11.31 simulated |
| Avg winner | +$2.51 | ~+$2.80 |
| Avg loser | -$1.63 | ~-$2.20 |

**Version B recommendation:** Remove regime threshold blocks, let Claude decide freely. Version B outperforms on direction flexibility.

**Mode 3 main failure:** Counter-trend LONG entries in TRENDING_DOWN regime (1W/8L = 11%).

**Current open positions (Mode 3, as of May 24):**

| Symbol | Dir | Entry | SL | Liq | Lev |
|--------|-----|-------|----|-----|-----|
| NEARUSDT | long | $2.3949 | $2.255 | $2.1772 | 10× |
| HYPEUSDT | long | $62.869 | $58.30 | $56.964 | 10× |
| ZECUSDT | long | $646.41 | $608.00 | $593.65 | 10× |
| TIAUSDT | long | $0.4274 | $0.412 | $0.3886 | 10× |
| BCHUSDT | short | $352.50 | $369.50 | $383.90 | 10× |
| INJUSDT | long | $5.157 | $4.970 | $4.689 | 10× |

Note: HYPE and NEAR have all swing lows below liquidation price — structural SL anchors do not exist above liq. SLs are liq-buffer placements, not structure-based. Fundamental position sizing concern.

**Version B status:** 8 open paper trades — do NOT close manually or reset balance. Running to natural SL/TP per A/B test protocol.

---

## 7. Watchlist & Scan

### 27 Bybit Perpetuals
ADAUSDT APTUSDT ARBUSDT ATOMUSDT AVAXUSDT BCHUSDT BNBUSDT BTCUSDT DOGEUSDT DOTUSDT ETCUSDT ETHUSDT FTMUSDT HYPEUSDT INJUSDT LINKUSDT LTCUSDT MATICUSDT NEARUSDT OPUSDT SOLUSDT SUIUSDT TIAUSDT TRXUSDT XMRUSDT XRPUSDT ZECUSDT

### Scan Schedule
- Main scan: every 4h (`0 */4 * * *`)
- Watch list rescan: every 30 min after main scan
- Watch list stops when: empty / 4h scan fires / position opened

### What Claude Sees at Scan Time (Phase 2, per symbol)
- MTF summary: close + RSI for 1m/15m/1D; close + RSI + EMA20/50 for 1h/4h
- **NEW:** Last 20 × 1h candles (OHLCV) — added May 24
- **NEW:** Last 20 × 15m candles (OHLCV) — added May 24
- Funding rate + OI
- **NEW:** Estimated liquidation price at 10× leverage — added May 24
- Relative strength vs BTC (4h/1D/7D avg)
- Liquidity sweep detection (last 10 candles)
- Squeeze detection (funding vs 50-period high/low)
- Table row: price, 7d%, 30d%, RSI, 24h volume
- Trade memory (last 5 reflections)
- Performance summary
- Active trading rules (3 rules, soft constraints)
- For open positions: entry, P/L, SL, TP, funding, key level, **liqPrice** — added May 24

### Cost Summary
| Item | Cost |
|---|---|
| Vultr server | ~$6/month |
| Anthropic API | ~$22-25/month (+~$2.20 for OHLCV candles) |
| Neon DB | Free tier (resets June 1) |
| **Total** | **~$30-33/month** |

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
| `/compare` | Mode 3 vs Version B stats | Free |
| `/autoscan now` | Triggers Claude scan | ~$0.09 |
| `/forceRules` | Triggers rule generation | ~$0.05 |
| `/closedust` | Closes tiny positions | Free |
| `/resume` | Resumes after daily limit | Free |
| NL messages | Claude API | ~$0.01-0.03 |

All long-output commands (`/memory`, `/positions`, `/paperhistory`) truncated at 3976 chars.

---

## 9. Active Bugs & Open Issues

### Pending (not yet implemented)
- **Hard gate for SL/TP** — code enforcement (not just a rule) to reject any signal without SL, TP, and setupType. Agreed but not deployed. Rule 1 covers this as a soft constraint only.
- **TIA TP1 missed** — TP1 reached but not triggered, 5% profit protection missed. Root cause unclear.
- **Scan to 30min** — currently 4h for testing stability; restore when balance >$50 and stable
- **maxTokens restore** — marketScanner 6000-8000, aiResponder 400 (currently conservative)

### Known Constraints
- Neon DB at 97.76/100 CU-hrs — resets June 1; subscribe if it hits limit before then (~$3-5)
- Version B paper balance: $26.31 (started $40) — do not reset
- HYPE and NEAR positions have no structural SL anchor above liquidation — high leverage relative to available support structure; positions carry liquidation-gap risk

### Resolved Today (May 24)
- ✅ Telegram "text is too long" errors — truncation applied to all three handlers
- ✅ DB entry_price storing planned price not actual fill — reconciliation now runs post-fill
- ✅ DB leverage storing LLM value not actual Bybit leverage — same fix
- ✅ Claude had no visibility into liquidation prices — now in prompt
- ✅ Claude had no OHLCV candle data — now sees last 20 × 1h and 15m per symbol
- ✅ HYPE/NEAR/ZEC SLs dangerously close to liquidation — adjusted on Bybit

---

## 10. Key Principles (Do Not Violate)

1. **Execution bugs → fix in code. Strategy decisions → Claude learns naturally.**
2. **Always use `./deploy.sh`** — never manual ssh one-liners (skips pnpm build, runs stale binary). Commit and push first — deploy.sh does `git pull` on the server.
3. **Bybit is source of truth for positions** — always use `pos.entryPrice`, `pos.leverage` from live API; never from DB trade_log
4. **DB trade_log is metadata, not source of truth** — entry_price stores intended price; leverage stores LLM suggestion. Both are now reconciled post-fill but still treat DB values as approximate
5. **Never suggest partial close at a loss** — SL exists to manage downside, let it work
6. **Do not add strategy rules** — let Claude discover through trade reflections and self-improvement
7. **Signal interpretation must be direction-aware** — RSI/funding mean opposite things for longs vs shorts; negative funding on a SHORT = squeeze risk, not confirmation
8. **Position review cannot contradict fresh entry** — entry context must be in review prompt
9. **SL must have meaningful gap above liquidation** — a gap of <1% is not protective; slippage through SL cascades to liquidation. Prefer structural anchor (swing low, EMA) that clears liq by at least 1× ATR
10. **No writing prompt during discussion** — discuss and confirm approach first
11. **Version B A/B test must not be interfered with** — no manual closes, no balance resets; let all trades run to natural SL/TP

---

## 11. June 1 Action Plan

1. Neon resets → DB CU-hrs back to 0, full operation resumes automatically
2. Force rules regeneration from clean post-fix trades (`/forceRules`)
3. Deploy hard gate: SL/TP/setupType required before any entry (code enforcement, not just rule)
4. Evaluate A/B test results: if Version B sustained outperformance → adopt unconstrained Claude approach for live trading
5. Consider adding more capital if performance confirmed
6. Restore scan to 30min when balance >$50 and stable
7. Restore maxTokens: marketScanner 6000-8000, aiResponder 400
8. Review HYPE/NEAR positions — both have SL above liq but no structural anchor. If still open, assess whether to reduce position size or close

---

## 12. Files & Key Locations

| File | Purpose |
|---|---|
| `artifacts/api-server/src/lib/cronScanner.ts` | Main 4h scan, position review, WatchScan, entry price reconciliation |
| `artifacts/api-server/src/lib/paperScanner.ts` | Version B paper trading |
| `artifacts/api-server/src/lib/tradeMemoryLib.ts` | Reflections, rules, learning loop, getDailyPnl (Bybit API) |
| `artifacts/api-server/src/lib/marketScanner.ts` | Signal generation prompts, OHLCV candles, liq estimates |
| `artifacts/api-server/src/lib/startup.ts` | Startup reconciliation, metadata healing |
| `artifacts/api-server/src/notifications/telegram.ts` | All Telegram commands |
| `artifacts/api-server/src/brokers/bybit.ts` | Exchange API — includes liqPrice in BybitPosition |
| `deploy.sh` | **Always use this for deployment** |
| `.env` | BYBIT_TRADING_MODE=live, PAPER_TRADING_ENABLED=true |

### Recent Commits (May 24, 2026)
| Commit | Description |
|--------|-------------|
| `46d9a8d` | fix: truncate /memory, /positions, /paperhistory to avoid Telegram 4096-char limit |
| `976342b` | fix: reconcile actual Bybit entryPrice and leverage into trade_log after fill |
| `34f522b` | feat: surface liqPrice in scan position context for Claude |
| `56de232` | feat: add estimated liquidation price per symbol to scan prompt |
| `97363b6` | feat: add last-20 1h and 15m OHLCV candles per symbol to scan prompt |
