# AI Trading Bot — Historical Handover Archive

> Pre-June 2026 fixes, A/B test history, and detailed change logs.
> Current project state: see **HANDOVER.md**
> Full commit history: `git log --oneline`

---

## Architecture History

### Entry Gates evolution (Mode 3)
- Score thresholds removed (`179cd00`) — no minimum by regime
- All regime hard blocks removed from `applyHardFilters()` (`3b6e5b6`, `d260ce0`) — Filter 1 gone
- Phase 2 scoring/regime instructions removed (`d1c16c9`) — Claude decides freely
- Hard gate still enforced: `stopLoss`, `tp1`, `setupType`, `score` must be present

### Version B Learning Gap (identified May 25, resolved May 25)
- Added `generateReflection()` on every Version B close with `source='version_b'` (`85492b9`)
- Added `getActiveRules()` call in `runPaperScan()` — rules injected as soft context (`85492b9`)

---

## A/B Test Status (May 24–27, 2026)

Version B went live May 27 — regime thresholds removed, Claude decides freely.
First Version B live trade: TP1 hit +$0.85 (May 27).

May 24–27 historical:
- Mode 3: 3 trades, 0% win rate, -$4.24 net (TIAUSDT SL, NEARUSDT review, TIAUSDT#2 review)
- Version B (paper): 1+ trade, NEARUSDT tp1_hit

BTC crash May 27–28: price $110k → $74k. All longs (ATOM/AVAX/TRX) SL-hit. Bot paused twice
(daily loss limit May 27 23:43 UTC; peak drawdown -41.9% May 28 02:11 UTC). Resumed May 28,
`peak_equity` reset to $21.82.

---

## Fixes Deployed May 24–25, 2026

**Telegram truncation (`46d9a8d`):** `/memory`, `/positions`, `/paperhistory` truncate at 3976 chars.

**DB data integrity (`976342b`):** `trade_log.entry_price` and `leverage` now reconciled from actual
Bybit fill post-order (was storing planned limit price / LLM-suggested leverage).

**Liquidation price surfaced (`34f522b`, `56de232`):** `BybitPosition` includes `liqPrice`; shown
in scan context and estimated per-symbol at 10× leverage.

**OHLCV candles added (`97363b6`):** Last 50 × 1h and 50 × 15m per symbol in Phase 2 prompt.

**`/forcerules` case fix (`9d8581a`):** Regex now case-insensitive (`i` flag).

**`/compare` bugs fixed (`aa663d4`, `41a08d5`, `67942f5`, `3be2c54`):**
- TP1 count overcounting — DISTINCT ON per trade with 4h time window join
- P&L sign missing minus — fmt() function fixed
- Version B status filter — ne(status,'open') instead of ='closed'
- Symbol collision — raw SQL DISTINCT ON (tl.id)
- Exit breakdown — TP1 | SL | Review | Timer now shown

**`/costs` command (`743d3d7`):** Live from existing `llm_usage_logs` table. Added `cache_write_tokens`
column, corrected cost formula, today/MTD/top callers/projected month-end display.

**Scan prompt improvements (`b5a2d21`):** Order book top 50 bids/asks, 24-period funding history.
+10,730 tokens/scan → +$0.19/day → ~+$5.80/month.

---

## Fixes Deployed May 26, 2026

**INJUSDT TP2 miss — three fixes (`5ba1ffc`):**
1. TP2 tier gate removed — `!pm.tp2Executed` is sole gate (stale `originalQty` can no longer block)
2. TP1 double-close prevention — `tp1Executed=true` set before `closePercentPosition(30)`
3. TP1 verification log — now checks partial conditional order separately from Full-mode TP2

**Version B portfolio review (`34548a6`):** Case-insensitive decisions, JSON schema enum, Haiku→Sonnet.
**Version B liq price in review (`d87fea2`):** `Liq(est)=$X` added from entry+leverage, no API call.

---

## Fixes Deployed May 27, 2026

**Regime hard blocks removed (`3b6e5b6`, `d260ce0`):** `applyHardFilters()` has no regime filter.
All regimes pass to Claude. Infrastructure-only filters remain.

**Regime score thresholds removed (`179cd00`):** `score < execThreshold` pre-filter removed from
`runCronScan()`. Claude's own judgment is the sole gate.

**`exitMethod` labeling (`276c7f7`):** `exitReasonOverride` added to `ReflectionInput`; all 7
`closeOpenTrade()` call sites pass explicit reason. P&L heuristic is fallback only.

---

## Fixes Deployed May 28–31, 2026

**Recent exit context in scan (`b77010e`):** Per-symbol last 24h exits injected after liqLines.
Shows exit method, hours ago, price — so Claude factors re-entry risk.

**Position limit max 3 (`46dbd03`):** Live Bybit count checked before every new entry.

**`/resume` peak drawdown loop fixed (`59969de`):** `resumeTrading()` resets `peak_equity` to
current live balance; drawdown measured from new post-resume baseline.

**`/resume` daily P&L loop fixed (`3a08669`):** `resume_at` timestamp added to `bot_state`;
`getDailyPnl()` window = `MAX(today 00:00 UTC, resume_at)`. One `/resume` clears both risk checks.

**Limit order lifecycle (`d5ae947`):** 4h stale cancel, fill detection in posMonitor, deferred SL/TP.
`pendingLimitFills` map; `setTp1Partial` extracted to `bybit.ts`.

**posMonitor improvements (`baab6f0`):** Recent exit context injected before review prompt.
PARTIAL_CLOSE/CLOSE bypass approval gate (was timing out on fast moves). P/L reformatted.

**Recent exits query fixed (`b2cfeb5`):** `ANY()` → `IN (sql.join(...))` — was silently failing on Neon.
Limit order execution fixed — `limitPrice` now threaded through to Bybit `Limit/GTC` order.

**Mode 3 paper trading (`5bd9d9d`):** Mode 3 paper simulation using Version B signals filtered by
Mode 3 gates. `/compare` rewritten — Version B live vs Mode 3 paper.

**Claude-driven ratchet SL (`ae059fc`):** Hardcoded 1.0×ATR trailing removed. Claude outputs
optional `NEW_SL [$price]` on 3rd line of any HOLD/PARTIAL_CLOSE; ratchet-only validation.

**Peak unrealized P/L tracking (`7ef9295`):** `peakPnlPct` in `PositionMeta`. Claude review shows
`P/L: +3.20% (peak: +6.80%)` when drawdown from peak >0.1%.

**Position review parse-fail alert + midnight SGT summary (`043d6fb`):** Alert on JSON parse fail.
Daily midnight SGT summary — pure Bybit+DB, no Claude call.

**TP1 double-close third attempt (`e5a25bf`):** Shared `partialExitRunning` mutex. Exchange TP1
silent detection (size <85% of origQty). 2s verification delay after trading-stop POST.

---

## June 1 Action Plan (completed)

1. ✅ Neon DB reset — CU-hrs back to 0
2. ✅ `/forceRules` — 15 rules from 110 reflections, $0.24
3. ✅ R:R hard gate deployed
4. ✅ Learning loop closed (reflections + rules for Version B)
5. Scan to 30min — deferred (balance <$50)
6. Capital top-up — pending evaluation

---

## Pre-Switch Checklist (Version B → live)

- [x] 48h auto-close removed from Version B
- [x] Hard gate active — SL/TP/setupType required
- [x] Entry price reconciled from Bybit after fill
- [x] Liquidation price in scan prompt
- [x] Order book, candle data, funding history in scan
- [x] Rules injected into Version B scan prompt
- [x] Reflections on every Version B close
- [x] Switch live capital to Version B logic (May 27)
- [ ] 5 clean trades closed — /compare reviewed
- [ ] Credit balance topped up
- [ ] Rollback plan confirmed

---

## All Commits May 24–31, 2026
| Commit | Description |
|--------|-------------|
| `46d9a8d` | fix: truncate /memory, /positions, /paperhistory |
| `976342b` | fix: reconcile actual Bybit entryPrice + leverage into trade_log |
| `34f522b` | feat: surface liqPrice in scan position context |
| `56de232` | feat: estimated liq per symbol in scan prompt |
| `97363b6` | feat: last-20 1h + 15m OHLCV candles in scan prompt |
| `9d8581a` | fix: /forcerules case-insensitive regex |
| `aa663d4` | fix: /compare TP1 count + P&L sign |
| `41a08d5` | fix: /compare Version B status filter |
| `67942f5` | fix: /compare DISTINCT ON per trade + review/timer counts |
| `3be2c54` | fix: /compare Version B add Review + Timer |
| `743d3d7` | feat: /costs command + cache_write_tokens |
| `b5a2d21` | feat: scan prompt — 50 candles, order book, funding history |
| `85492b9` | feat: Version B rules injection + reflections |
| `5ba1ffc` | fix: TP2 tier gate, TP1 double-close, TP1 verification log |
| `34548a6` | fix: Version B portfolio review |
| `d87fea2` | feat: Version B portfolio review liq price |
| `276c7f7` | fix: exitReason explicit through all closeOpenTrade call sites |
| `179cd00` | fix: remove regime score thresholds from cron scan |
| `3b6e5b6` | fix: remove CHOPPY/EXHAUSTION hard block |
| `d260ce0` | fix: remove VOLATILE hard block |
| `d1c16c9` | fix: remove regime/scoring instructions from Phase 2 |
| `d8e5b89` | fix: simplify Phase 1 systemContext |
| `af178d5` | fix: openPosition() leverage cap + skip if already set |
| `b77010e` | feat: recent exit context in Phase 2 scan prompt |
| `46dbd03` | feat: position limit max 3 open |
| `59969de` | fix: resumeTrading() resets peak_equity |
| `3a08669` | fix: resume_at timestamp for daily P&L window |
| `d5ae947` | feat: limit order 4h cancel + fill detection + deferred SL/TP |
| `baab6f0` | feat: posMonitor recent exit context + auto-execute + P/L format |
| `b2cfeb5` | fix: recent exits ANY() bug + limit order execution |
| `5bd9d9d` | feat: Mode 3 paper + /compare rewrite |
| `ae059fc` | feat: Claude-driven ratchet SL replaces ATR trail |
| `7ef9295` | feat: peak unrealized P/L tracking |
| `043d6fb` | feat: parse-fail alert + midnight SGT summary |
| `970d968` | fix: /history duration fix |
| `e5a25bf` | fix: TP1 double-close third attempt (mutex + exchange detection) |
