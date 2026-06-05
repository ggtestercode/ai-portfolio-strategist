# Trading Bot — Current State
**Commit:** ac32f03 | **Date:** June 5, 2026 | **Server:** root@139.180.215.150

---

## 1. HARD GATES (code-enforced, no LLM override)

All gates live in `artifacts/api-server/src/lib/cronScanner.ts`. Applied on **two independent code paths** — `applyHardFilters()` (cron scanner) and the watchScan inline gate — so no path bypasses them.

### Gate 1 — Downtrend Long Block
**File:** `cronScanner.ts:296-303` (applyHardFilters) + `cronScanner.ts:1387-1395` (watchScan)  
**Condition:**
```typescript
if (opp.direction === "long") {
  const bearishStrong = r === "STRONG_TREND" && diMinus > diPlus;
  if (r === "TRENDING_DOWN" || bearishStrong) → REJECT
}
```
**Blocks:** Any LONG when BTC 4h regime is TRENDING_DOWN (ADX>25, DI->DI+) OR STRONG_TREND with DI->DI+ (ADX>35, bearish direction). Historically 0% TP1 hit rate for longs in either. Rationale embedded in Rule 1.  
**NL path (aiResponder/manual):** NOT covered — documented in HANDOVER.md as open item.

### Gate 2 — Low Liquidity
**File:** `cronScanner.ts:306-310`  
**Condition:** `volume24h < $10M` → REJECT  
**Blocks:** Any symbol with insufficient daily volume regardless of setup quality.

### Gate 3 — RANGING Boundary
**File:** `cronScanner.ts:327-338`  
**Condition:** In RANGING regime, LONG must be within 3% of 50-period low; SHORT within 3% of 50-period high.  
**Blocks:** Mid-range entries in ranging markets (only boundary fades allowed).

### Gate 4 — EMA Trend Alignment
**File:** `cronScanner.ts:351-361`  
**Condition (trending regimes):** LONG rejected if price > 3% below 4h EMA50. SHORT rejected if price > 3% above 4h EMA20.  
**Blocks:** Counter-trend entries in trending regimes. Skipped in RANGING (price oscillates through EMAs by design).

### Gate 5 — R:R Minimum
**File:** `cronScanner.ts:1686-1694` (cron) + `cronScanner.ts:1399-1407` (watchScan)  
**Condition:** `|tp1 - entry| / |entry - sl| < 1.1` → REJECT (computed from raw signal values, not Claude's reported field)  
**Blocks:** Any signal where reward is less than 1.1× risk at TP1. TP1 clamping (if added later) interacts here — a clamped TP1 that drops R:R below 1.1 would be cleanly rejected.

### Gate 6 — Required Fields
**File:** `cronScanner.ts:1671-1677` (cron) + `cronScanner.ts:1371-1377` (watchScan)  
**Condition:** `tp1 == 0 || !stopLoss` → REJECT  
**Blocks:** Any signal missing TP1 or SL. Claude is explicitly told a zero-TP1 signal will be rejected.

---

## 2. ACTIVE RULES (9)

Displayed to Claude at bottom of every scan prompt. Marked SOFT — Claude can override with stated reason.  
Filter: only `sl_hit` and `tp_hit` exit types feed into rule win/loss attribution.

| # | Confidence | W/L | Rule |
|---|---|---|---|
| 1 | HIGH | 1W/14L | **HARD VETO:** Never enter a LONG position when regime is TRENDING_DOWN or when regime is STRONG_TREND with DI- > DI+ (bearish strong trend). These are structurally equivalent downtrends — TRENDING_DOWN has ADX>25 DI- dominant; bearish STRONG_TREND has ADX>35 DI- dominant. Both have 0% historical TP1 hit rate for longs. The only valid directions in either are SHORT or NO TRADE. No RS rank, RSI oversold reading, score, or funding signal overrides this veto. This rule is enforced as a HARD CODE GATE — Claude cannot override it. |
| 2 | HIGH | 1W/6L | **MANDATORY PRE-ENTRY CHECKLIST:** Every trade must have SL, TP1, and TP2 defined as hard limit orders on exchange BEFORE entry is submitted. Trades without all three fields populated are rejected. Additionally verify open orders match planned levels immediately post-fill. No trade is placed on NL/undocumented instructions without setup type name and score >= 70. |
| 3 | HIGH | 1W/14L | **TP1 CALIBRATION BY REGIME:** Set TP1 within the historically observed max profit range for each regime, not at theoretical RR multiples. TRENDING_DOWN longs (if taken): TP1 max 1.5% from entry. RANGING regime: TP1 max 1.5% from entry. EXHAUSTION regime: TP1 max 2.0% from entry. CHOPPY regime: TP1 max 2.5% from entry. STRONG_TREND longs and shorts: TP1 2-3% from entry, TP2 4-8% from entry. TRENDING_UP longs and shorts: TP1 2-3% from entry, TP2 4-8% from entry. TRENDING_DOWN shorts: TP1 2-3% from entry, TP2 4-6% from entry. Rationale (Jun 2026 path-aware data, 15 STRONG_TREND long trades): 40% hit 3% before SL; of those, 83% continued to 6%+. The 3-8% zone is empirically empty — setting TP1 at 6-8% misses the early partial and pushes TP2 to unreachable 16%+. TP2=2x TP1 distance produces 4-6% given TP1=2-3%, which is reachable. |
| 5 | HIGH | 1W/14L | **HYPE RS LEADERSHIP VETO ON SHORTS:** When HYPE RS vs BTC is the highest in the scan (above +5%) AND 1h structure is HH/HL AND 15m structure is HH/HL dominant with rising volume — do NOT enter short under any circumstances regardless of regime label, entry candle, or score. Treat this three-signal combination as a 100% long continuation signal. If already in a short against these signals, exit immediately. |
| 7 | HIGH | 1W/14L | **TP EXECUTION VERIFICATION:** Immediately after every entry fill, verify TP1 and TP2 limit orders are live and showing in the Bybit open orders panel before stepping away from the position. Set a manual price alert at TP1 as redundancy. If TP1 registers reached=YES but executed=NO, this is a systemic exchange-side bug requiring investigation — do not proceed with new trades until root cause is identified and resolved. |
| 8 | HIGH | 1W/14L | **NO PARTIAL CLOSES BELOW ENTRY PRICE:** On any trade, no partial close is executed at a price worse than entry. For longs: all partials must be at prices above entry. For shorts: all partials must be at prices below entry. The first partial close is only permitted after price has moved minimum 1.0% in trade direction. posMonitor review must not trigger partial closes within the first 30 minutes of entry on MOMENTUM setups with score >= 70. |
| 10 | HIGH | 1W/14L | **VOLUME CLIMAX EXHAUSTION FILTER FOR SHORTS:** Cancel any short entry when the pre-entry 1h candle structure shows a volume spike of 4x+ average on a bearish candle followed immediately by a recovery candle with 1.5x+ average volume. This pattern indicates climactic selling exhaustion, not continuation. Apply same logic to 15m timeframe: if 15m candle 7 prints 4x+ average bearish volume followed by 15m-8 with partial recovery, delay short entry by minimum one full 1h candle. |
| 11 | HIGH | 1W/14L | **CHOPPY REGIME ENTRY DISCIPLINE:** In CHOPPY regime, only enter MOMENTUM setups with score >= 72 when the 12h trend is not actively adverse beyond 2% against trade direction AND the final 15m candle (15m-8) has body >= 30% in trade direction. Do not enter LIQUIDITY_SWEEP setups in CHOPPY regime unless price has confirmed a 1h candle close above the sweep level with body >= 50%. SL minimum = 5.5% from entry in all CHOPPY regime trades. |
| 14 | HIGH | 1W/14L | **RANGING AND EXHAUSTION REGIME TP CAPS:** In RANGING regime, set TP1 maximum 1.5% from entry and TP2 maximum 2.5% from entry regardless of setup type or score. In EXHAUSTION regime, set TP1 maximum 2.0% from entry and TP2 maximum 3.5% from entry. Close 60-70% of position at TP1 given historically low continuation rate beyond first target in these regimes. Do not enter MOMENTUM longs in EXHAUSTION regime on upper-wick rejection 1h candles — require lower-wick PIN BAR with 4/8+ HH/HL 15m candles before entry. |

---

## 3. INACTIVE RULES (6)

Removed from the active scan prompt. Win/loss tracking continues but Claude does not see these rules.

| # | W/L | Why Inactive |
|---|---|---|
| 4 | 0W/11L | **Entry candle direction filter** — 0% win rate post-creation; too restrictive on fast-moving MOMENTUM setups where waiting for candle close causes missed entries. |
| 6 | 0W/11L | **SL width by regime** — 0% win rate; prescriptive ATR multipliers conflicted with the actual SL distances Claude was placing (the guidance was incorporated into Rule 3 and prompt instead). |
| 9 | 0W/11L | **STRONG_TREND RS rank 1 sizing** — removed because it contained "TP1 minimum = 6%" which directly contradicted the June 2026 TP calibration finding (6-8% sits in the dead zone). Updated version of TP guidance now in Rule 3. |
| 12 | 0W/11L | **After TP1 — move SL to breakeven** — 0% win rate; the breakeven SL is already implemented as a hard code mechanism (posMonitor ratchet at +2% P/L and TP1 ratchet to entry±1% post-partial). Prompt guidance was redundant and the rule had poor attribution. |
| 13 | 0W/11L | **Version B premium limit** — 0% win rate; Version B was a separate A/B test tracking system that has since concluded. Rule referenced Version B pricing which no longer applies. |
| 15 | 0W/11L | **OPUSDT rejection short framework** — 0% win rate; symbol-specific rule with narrow applicability. The EMA20 resistance zone at $0.126-0.132 may no longer be structurally valid as OP price has moved significantly. |

---

## 4. TP/SL CALIBRATION

### Regime-specific TP bands (source: Rule 3 DB + scan prompt dynamic line)

Injected into every scan prompt immediately after the regime block, so Claude sees it before choosing TP1:

| Regime | TP1 | TP2 | Notes |
|---|---|---|---|
| STRONG_TREND (bullish) | 2–3% | 4–8% | Updated Jun 5, 2026 from data analysis |
| STRONG_TREND (bearish) | LONGS BLOCKED | — | Gate 1 hard-blocks longs |
| STRONG_TREND shorts | 2–3% | 4–6% | — |
| TRENDING_UP | 2–3% | 4–8% | Same as STRONG_TREND |
| TRENDING_DOWN (shorts only) | 2–3% | 4–6% | Longs hard-blocked |
| RANGING | max 1.5% | max 2.5% | Rule 14; Gate 3 also enforces boundary |
| EXHAUSTION | max 2.0% | max 3.5% | Rule 14 |
| CHOPPY | max 2.5% | max 4.0% | Rule 11 + 14 |
| VOLATILE | 1–3× ATR structural | — | No specific cap; uses ATR fallback |

### TP2 cascade
`TP2 = 2× TP1 distance` (hardcoded in scan prompt). At TP1=2% → TP2=4%; TP1=3% → TP2=6%. Automatically within the 4–8% band for STRONG_TREND given compliant TP1.

### SL placement
`SL = entry ± 1.5× 4h ATR` (scan prompt). Ratchet triggers:
- Breakeven ratchet: SL moves to entry when P/L hits +2% (posMonitor)
- TP1 ratchet: SL moves to entry ± 1% after TP1 partial executes (cronScanner)

### Data basis for STRONG_TREND calibration
Path-aware analysis of 15 STRONG_TREND long trades (June 2026 corrected timestamps):
- 40% hit 3% before SL (6/15); 83% of those continued to 6%+
- Dead zone: no trade peaked between ~3.3% and 8.4% — making 6–8% TP1 both a dead zone and a TP2 blocker
- Only well-calibrated trade: HYPE May30 (TP1=3.86%, TP2=~7.7%) — both targets hit, +7.84% final PnL

---

## 5. KEY ARCHITECTURAL DECISIONS

### "Let Claude decide freely" philosophy
Claude sets all entry parameters (symbol, direction, entry, SL, TP1, TP2, sizing, leverage) based on live market data. Hard gates (section 1) enforce structural constraints code-side. Rules (section 2) are soft guidance — Claude can override with stated reason. This separation keeps the execution layer deterministic while letting the analysis layer adapt.

**Exceptions where code overrides Claude:**
- Downtrend long block (Gate 1) — 0% TP1 hit rate historically, no exception
- R:R < 1.1 (Gate 5) — minimum structural viability
- Missing TP1/SL (Gate 6) — non-negotiable, position safety

### Downtrend hard gate — when to revisit
**Primary trigger:** Revisit/relax this gate only once the bot has a mature, trustworthy profitability record — meaning the clean baseline (Jun 4+) shows consistent profitable performance across 20+ trades. Until that threshold is met, the gate stays regardless of any other conditions. The historical data that prompted it (0% TP1 hit rate for bearish STRONG_TREND longs) was unambiguous; removing the gate before the bot has proven itself risks re-introducing the single largest source of losses in the dataset.

Secondary conditions to evaluate at that point:
1. At least 5–10 clean trades under STRONG_TREND bullish regime (to confirm the gate only blocked the bad direction, not good longs)
2. BTC regime has transitioned through TRENDING_UP or RANGING for ≥1 week (context has changed enough to re-test)
3. A bullish STRONG_TREND long hitting TP2 while Gate 1 was active on bearish STRONG_TREND is NOT evidence to relax — those are different regimes

The NL path (aiResponder) currently bypasses Gate 1. Open item: fetch current regime in aiResponder and apply same check.

### Why rule generation filters to sl_hit/tp_hit only
Manual closes (`review` exit type) are classified with a `manualCloseVerdict` field (correct/wrong/neutral) by Claude. These outcomes are ambiguous — a manual close at breakeven is neither a win nor a loss in terms of rule validity. Including `review` exits would dilute rule attribution with noise. Only `sl_hit` (rule didn't help) and `tp_hit` (rule was followed and won) give clean signal.

### Why reconstruction never touches actual P&L
Phase 3 reconstruction walks forward from actual close time to estimate what *would* have happened. It writes to `pnl_source` and `reconstructed_outcome` only — never to `pnl`, `pnl_pct`, or any column used in financial reporting. The actual realized P&L is immutable. Reconstruction informs Claude's self-evaluation prompt (manualCloseVerdict) but does not change what the account booked.

---

## 6. DATA LAYER STATUS

### Phase 1 — Structured reflection fields (complete)
Basic trade memory: entry quality, direction correctness, SL/TP placement grades, partial timing, lessons learned. Written to `trade_memory` on every close. Powers the `trade memory` context block in scan prompts.

### Phase 2 — Exit method classification (complete, deployed Jun 4)
`resolveExitReason()` in `startup.ts` classifies each closed trade as: `sl_hit` | `tp_hit` | `profit_protection` | `48h_timer` | `manual_partial` | `manual_full` | `review` | `unknown`. Uses stop order lookup + partial record window. Timing bug fixed Jun 4 (was using `new Date()` instead of actual close time — caused all startup reconciliations to use restart timestamp).

### Phase 3 — Forward reconstruction (complete, deployed Jun 4)
For `manual_partial` and `manual_full` exits, walks 200× 15m klines forward from actual close time. Compares ratcheted SL vs TP1/TP2 levels. Intra-candle: if TP+SL hit same candle → `ambiguous_excluded`. Outcomes: `tp2_hit` | `tp1_hit` | `sl_hit` | `inconclusive_review` | `ambiguous_excluded`. Results feed `manualCloseVerdict` in Claude's reflection prompt. Writes to `pnl_source` / `reconstructed_outcome` columns (nullable text, never touches financial P&L).

### Phase 4 — Per-rule attribution (backlogged)
Current system credits all active rules when a trade wins/loses (Option 1 — all-rules-credited). Option 2 (per-rule attribution) would use code to evaluate which specific rule conditions were actually met at trade entry and credit only those. Deferred pending more clean data to make attribution statistically meaningful.

### Known data limitations
- **Portfolio margin cap:** Bybit account uses portfolio margin. The `positionIM` field (initial margin) does not account for cross-margin netting correctly when multiple positions are open — margin utilisation may be understated in logs.
- **`tp1Executed` false positive bug:** `pos.size < origQty * 0.85` in `cronScanner.ts:648` falsely marks `tp1Executed=true` for manual partial closes (which reduce size but do not trigger the TP1 order). Identified, not yet fixed.
- **TP1 order-not-on-exchange (silent miss):** Price physically crosses TP1 level (`tp1_reached=TRUE` in trade_memory) but the partial close never fires because the TP1 limit order was not placed on Bybit at entry time. Bot logs show `triggered: tp1=false` even though current price is past TP1. This is distinct from the false positive above — it is a missing order, not a mislabeled flag. Root cause: TP order placement failure at entry. Detection: posMonitor logs `triggered: tp1=false` while price is clearly past TP1 price. Mitigation: Rule 7 requires manual verification of open orders after every fill.
- **DB reconciler misses TP partials:** `startup.ts` reconciler does not detect TP1/TP2 partials that executed while the bot was offline — these appear as full-size closes with incorrect pnl attribution.
- **Manual closes mislabeled:** Some manual closes are labeled `sl_hit` in exit_method due to how Bybit reports market orders from stop triggers.

---

## 7. OPEN ITEMS / BACKLOG

### High priority
1. **NL path downtrend gate** — `aiResponder.ts` bypasses `applyHardFilters`. Fetch current BTC regime and apply Gate 1 check before executing NL long entries. Low-risk add, important for consistency.
2. **`tp1Executed` false positive** — `cronScanner.ts:648`: `pos.size < origQty * 0.85` triggers for manual partials. Fix: only set `tp1Executed=true` when the TP1 *order* executes, not just when size shrinks.
3. **Capital top-up decision** — balance ~$19–20 with ~$6.56 in margin, ~$13 free. At current position sizes ($3–4 per trade), approximately 3–4 more trades possible before the account is too small for meaningful positions. Review after 5–10 clean post-Jun-4 trades.
4. **`/forceRules`** — re-run rule scoring against the 5–10 clean trades post-Jun-3 fixes to confirm rule win/loss counters are updating correctly with the new classification pipeline.

### Medium priority
5. **DB reconciler TP partial detection** — on startup, check if position size is smaller than expected and infer whether TP1/TP2 partially executed during downtime.
6. **Per-rule attribution (Phase 4)** — replace all-rules-credited with code-evaluated relevance tracking. Requires ~20 more clean trades with sl_hit/tp_hit exits for meaningful signal.
7. **Hard TP1 ceiling clamp** — soft guidance is the current state (Rules 3/9). If Claude continues to overshoot the 3% cap after 5+ scans, add a code clamp in `applyHardFilters` (plan already drafted: `clampTp1ToRegimeCap()` helper returning `ok/clamped/reject`).
8. **Re-entry cooldown** — no cooldown logic after a stop-out. Claude can re-enter the same symbol immediately. Consider a 1-candle (15min) or 1-hour cooldown per symbol after SL hit.

### Low priority / deferred
9. **OPUSDT rule (Rule 15)** — symbol-specific rule inactive. Re-evaluate if OP retests the $0.126–0.132 zone with new calibration.
10. **Version B cleanup** — A/B test concluded. Paper trade tracking code (`paperMonitor`) still running. Can be disabled if paper trades are all closed.

---

## 8. PERFORMANCE BASELINE

### Pre-baseline (contaminated — do not use for strategy evaluation)
All trades before June 4, 2026 contain multiple compounding bugs:
- SL bugs #4 (setSlTpForExistingPositions not preserving ratcheted SL on restart), #5 (applyAtrSlTp priority chain), #6 (getOrders missing settleCoin)
- Wrong-direction longs in bearish STRONG_TREND (no downtrend gate)
- TP1 at 6–8% (dead zone — no partial profits captured)
- resolveExitReason using `new Date()` instead of actual close time (Phase 2 timing bug)

**All-time stats (132 closed trades including contaminated):** 37W / 68L / 22BE | Net: -$47.67 | Avg win: $0.58 | Avg loss: $1.02

### Clean baseline — June 4, 2026 onward
First scan with all fixes live: June 4, 2026 08:00 UTC (commit 4156480 deployed prior session).

**June 4–5 closed trades (5 trades, 2 open):**

| Date | Symbol | Dir | PnL | PnL% | Duration | Notes |
|---|---|---|---|---|---|---|
| Jun 4 | LINKUSDT | Short | +$2.50 | +2.52% | ~22h | Clean win, TP hit |
| Jun 4 | INJUSDT | Short | -$1.27 | -2.53% | ~1.7h | Stop out |
| Jun 4 | ETHUSDT | Short | -$0.05 | -0.08% | ~4.5h | Breakeven close |
| Jun 4 | LINKUSDT | Short | -$0.04 | -0.08% | ~4.5h | Breakeven close |
| Jun 5 | ETCUSDT | Short | $0.00 | 0.00% | ~8h | Closed at entry (auto) |

**Clean baseline stats (5 closed):** 1W / 1L / 3BE | Net: +$1.14  
**Open positions (Jun 5 07:40 UTC):** BNBUSDT short (entry $600, SL $615, TP1 $579, TP2 $558, +1.7%) · ETCUSDT short (entry $7.039, SL $7.25, TP1 $6.79, TP2 $6.54, +0.9%)

**Account balance:** ~$19–20 (estimated; $18.51 prior to Jun 4 + ~$1.14 net). Margin committed: ~$6.56 ($3.54 ETC + $3.02 BNB).

**Note on TP calibration:** The LINK short (+2.52%) and the recent ETC/BNB shorts running profitable are the first trades under the new 2–3% TP1 / 4–8% TP2 guidance. LINK hit TP at ~2.59% — directly in the calibrated band. This is the pattern the new guidance targets.

---

*Generated: 2026-06-05 | Commit: ac32f03 | Next review trigger: 5–10 clean trades or balance below $15*
