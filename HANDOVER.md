# AI Trading Bot — Handover
**Last updated:** June 21, 2026 (commit b5e7e40)
**Full history:** HANDOVER_ARCHIVE.md and `git log --oneline`
**Repo:** https://github.com/ggtestercode/ai-portfolio-strategist
**Server:** Vultr Singapore — `root@139.180.215.150`
**Deploy:** `./deploy.sh` — always use this; never manual ssh. Pushes to origin first, verifies commit hash on server.

---

## Current State

- **Balance:** ~$26 | **Exchange:** Bybit Live | **Infra:** PM2 on Vultr, Neon PostgreSQL
- **Open positions:** HYPE long, INJ long, XRP short (check `/positions` for live state)
- **Scan:** every 4h (`0 */4 * * *`) | posMonitor: every 5 min
- **Learning rules:** 17 active (redesigned rule-gen pipeline June 21 — counterfactual engine + 3-phase LLM gate; see System Change sections below)
- **Neon DB:** reset June 1 ✅ — CU-hrs back to 0

---

## Architecture

### Signal Flow
1. **Phase 1 (Haiku)** — selects top 10 symbols by RS vs BTC from 27 watchlist symbols
2. **Phase 2 (Sonnet)** — per-symbol: MTF, 50 candles, order book, funding history, recent exits, pending orders → signal JSON
3. **Hard gates** — SL/TP1/setupType/score present; R:R ≥ 1.1 (computed from raw values); extreme funding >0.1%; HTF boundary; EMA alignment; liquidity <$10M; **downtrend long block** (TRENDING_DOWN or STRONG_TREND DI->DI+) — code-enforced, Claude cannot override. ⚠️ NL free-text trades via Telegram bypass this gate (routes through aiResponder→approvalGate, no regime check).
4. **Position limit** — max 3 open (live Bybit count before any new entry)
5. **posMonitor** — 5-min tick; Claude review every 4h (sooner at drawdown or RSI/OI triggers)

### Entry Signal Schema (key fields Claude returns)
`symbol, direction, score, entry, stopLoss, tp1, tp2, rewardRiskRatio (required), setupType, tp1ClosePercent (default 30), tp2ClosePercent (default 100), limitPrice`

### Exit System
- **TP1:** close `tp1ClosePercent`% (default 30%), SL → entry×1.01 (long) / entry×0.99 (short), set `tp1Executed=true`
- **TP2:** close `tp2ClosePercent`% of remaining (default 100% = Full-mode). If <100%, exchange sets Partial TP via `trading-stop`
- **Mechanical breakeven ladder (posMonitor, zero API cost):**
  - P/L ≥ +2% → SL to entry price (self-gating: only fires when SL still below/above entry)
  - TP1 hit → SL to +1% (above entry for longs, below for shorts)
  - SL only ratchets tighter, never loosened; Claude's NEW_SL can further tighten above this floor
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
- Accurate liq price using actual portfolioLeverage (capped 10×, formula: entry×(1-1/lev+0.005) for longs) + scan prompt rule: SL ≥2% above liq (longs) / ≤2% below (shorts)
- Relative strength vs BTC (4h/1D/7D)
- Liquidity sweep + squeeze detection
- Trade memory (last reflections) + performance summary
- 17 active trading rules (soft constraints; TP1 is **code-set** — 1.0% CHOPPY / 2.5% non-CHOPPY — LLM output overridden at runtime; TP2 is LLM-set under regime×setup cap)
- Open positions: entry, P/L, SL, TP, peak P/L, liqPrice
- Recent exits (last 24h): exit method, hours ago, price
- **Pending limit orders** (unfilled): direction, price, qty, hours pending

### Learning System
- **Reflections:** Every close (Mode 3 + Version B) — 24 structured fields
- **Rules:** Generated every 20 trades from all reflections; `/forceRules` bypasses gate
- **Rule generation:** Claude reads all `trade_memory` TRADE_CLOSE rows; DELETE+INSERT (no stale rules)
- **Version B:** Fully symmetric — reflections fire on close, rules injected in prompt

---

## Recent Commits
| Commit | Description |
|--------|-------------|
| `b5e7e40` | feat(scanner): regime×setup-conditional TP2 anchoring (1h MOMENTUM, 4h LIQSWEEP) |
| `a5f1646` | fix(rules): deactivate 31/32 + Gate 1c closes embedded-TP1 bypass |
| `16740df` | feat(rules/apply): renumber to 20+, preserve safeguards 5/10/14/15, fix tensions |
| `0694c20` | fix(rules/gate3): use lever-appropriate engine number for counterfactual-match |
| `b6191dc` | feat(rules/phase3): post-LLM validation gate — engine classification authoritative |
| `8885c18` | feat(rules/phase2): balanced rule-gen — engine-fed prompt, loss-avoidance + win-amplification |
| `9538144` | feat(tp1): regime-conditional TP1 — CHOPPY 1.0%, non-CHOPPY 2.5% |
| `d26afdc` | fix(counterfactuals): snap TP2 cap to sweep value; sharpen borderline reason |
| `39997e8` | fix(deploy): exclude backfill_* snapshot tables from drizzle-kit push |
| `128c1c1` | fix(backfill): use Bybit stopOrderType for exit_method instead of pnlPct inference |
| `2d2ef43` | fix(reflection): same 10s anchor guard in generateReflection bybitCloses fetch |
| `95d8382` | fix(reconciler): exclude prior-trade closes from PnL matching |
| `91e029b` | fix(posMonitor): intent-aware dust-guard for PARTIAL_CLOSE |
| `6f8197c` | fix(posMonitor): volume-spike trigger direction-aware (hybrid Option B) |
| `7191053` | fix(choppy): raise TP2 cap 2.5%→3.5% — restores CHOPPY R:R viability |
| `7573073` | fix(choppy): regime-aware TP1 ceiling + early breakeven trigger |
| `3ece093` | fix(rules): reset W/L stats + protect inactive rules from regen trim |
| `f913a81` | fix(posMonitor): RSI>75 trigger direction+context aware — suppress on winning shorts |
| `180871b` | fix(scan): silent scan-failure bug — Fix 6 (alert) + Fix 4 (verbosity + cap) |
| `89e4532` | fix(gates): Rules 2/7/8 code enforcement |
| `8b11f89` | docs: HANDOVER — SL ladder + accurate liq price (June 3) |
| `9ef7c64` | feat: SL ladder + accurate liquidation price |
| `5291d3f` | fix: SL integrity — priority chain + trailingActive inheritance |
| `eda8458` | docs: HANDOVER.md — reconciler overwrite bug + DB corrections (June 2) |
| `ec5df72` | fix: SL on restart takes more-protective of trade_log.sl vs positionMetadata.sl |

---

## Open Items
- **Scan to 30min** — currently 4h; restore when balance >$50 and stable
- **Capital top-up** — consider if performance confirmed
- **tp1 always required in signal** — fixed `d3bfcf2`: prompt hardened + gate uses `v <= 0` for numerics
- **SL-to-liquidation buffer** — scan prompt now instructs Claude to keep SL ≥2% above (longs) / ≤2% below (shorts) liquidation price; liq price is now computed accurately from portfolioLeverage (capped 10×) not hardcoded. Informational — not a hard gate.
- **Per-rule attribution (Option 2 — code-evaluated)** — Replace current `appliedRuleIds` approach (all active rules credited to every trade, making per-rule stats meaningless) with: code records which active rules were RELEVANT to each trade (e.g. Rule 1 only relevant if regime=TRENDING_DOWN) and whether the trade COMPLIED or VIOLATED each. Goal: "trades following Rule X win Y% vs violating Z%" — real signal on rule helpfulness. Only works for mechanically-checkable rules (regime, direction, TP/SL distance). Build AFTER DB reconciler fix — needs accurate P&L first.
- **Portfolio-level total margin cap** — No guard against sum of all open position margins exceeding X% of balance. Each position is individually capped at 30%, but three simultaneous positions each at 30% = 90% margin deployed. Fine at current scale (2-3 positions, $20-50 balance). Add cap when balance grows beyond ~$100 and position count increases.
- **Reconciler uses time-based fill attribution (not orderId)** — DB stores no Bybit `orderId` per trade. The 10s anchor guard eliminates the confirmed class of cross-attribution (prior same-symbol close). Only add orderId matching (schema change to `trade_log`) if a future overlap defeats the time filter (e.g., two same-symbol trades opened within 10s of each other).
- **Watch live: 1h TP2 placement** — deployed `b5e7e40`. First MOMENTUM trade in STRONG_TREND/TRENDING should show TP2 at 3.5–4.5%, not 6–7%. If LLM still outputs 6%+ on a MOMENTUM setup, the new instruction isn't landing — sharpen the prompt wording.
- **Watch live: TP1 rescue on reversal** — deployed `9538144`. Next trade that reverses after going in-the-money should trigger TP1 partial at 1% (CHOPPY) or 2.5% (non-CHOPPY) and ratchet SL to +1%/+2%.
- **Parked: non-CHOPPY TP2 sweep** — run per-regime TP2 distribution analysis (at 3.0%, 3.5%, 4.0%, 5.0%, 5.5%, 6.0%, 6.5%) against full population once n grows to ≥15 per regime. Currently n=3 for EXHAUSTION (inert at 3.0% cap — 0/3 reached), n=2 for RANGING, n=7 weak for TRENDING. STRONG_TREND long 6.5% cap is slightly loose (max observed 5.98%) — revisit at n=20.
- **Parked: rule consolidation at next rule-gen** — DB rules 14/35 (TP2 regime caps) are now partially redundant with `tpCapShort()` in marketScanner.ts (the authoritative hard channel). At next rule-gen, do not re-emit separate TP2-cap rules — they add noise without adding enforcement. Soft rules covering what code already handles should be pruned.
- **Parked: soft→hard promotion** — Rule 5 (RS Leadership Veto on shorts) is a soft DB rule; if further data confirms it is negative-EV to override, promote to a code gate in `applyHardFilters`. Needs clean W/L split with and without override before acting.
- **Parked: shadow-tracking + demotion** — no mechanism yet to auto-demote rules with consistently negative track records once n grows. Add a W/L ratio gate at next rule-gen review.
- **Parked: admin endpoint cleanup** — `/admin/re-reflect`, `/admin/preview-rules`, `/admin/counterfactuals`, `/admin/apply-rules` exist in `performance.ts`. Consider adding auth or removing stale endpoints before going to larger scale.
- **R:R baseline** — win rate 41.3%, net −$41.15, avg win $0.889, avg loss −$1.268, R:R 0.70 (109 trades, Jun 15 corrected). Track whether new TP2 anchoring improves R:R on post-`b5e7e40` MOMENTUM trades.
- **effective_sl not captured for offline/backfilled closes** — when a position closes while the bot is down (reconciled on next startup), `effective_sl` is not written to `trade_log` even if the SL was ratcheted. Caused 6bdeb8b3's `effective_sl=NULL`, which defaulted to `original_sl` before manual correction. Pre-existing gap; fix would require startup reconciler to infer effective_sl from exit price vs original SL when stopOrderType=StopLoss. Low priority — the scan (`exit_vs_sl_gap > 0.3%` for longs, `< -0.3%` for shorts) confirmed only 1 mislabeled ratchet in 30 days of data.

## Fix — SL Integrity (June 3)

Three bugs in `startup.ts` caused exchange SL to diverge from Claude's planned SL across restarts.

**Bug 1 — ATR overwrote Claude's SL on restart:**  
`setSlTpForExistingPositions()` fell through to ATR×1.5 whenever metadata was stale/missing (common after 347 restarts). The ATR formula placed wider SLs than Claude planned — confirmed to be the cause of HYPEUSDT/NEARUSDT closing -2–4% below their DB-stored SL prices on June 2.

**Fix:** SL priority chain on restart:
1. Read `trade_log.sl` (Claude's planned value, written by cronScanner at entry) → use if valid vs live price
2. Read exchange `stopLoss` → preserve it if valid vs live price
3. ATR fallback — only if no SL exists anywhere

**Bug 2 — `trailingActive` inherited by new position on same symbol:**  
`storePositionMeta()` copied `trailingActive` and `lastTrailPrice` from existing metadata when storing new position data. Since `reconcileClosedPositions()` doesn't call `clearPositionMeta()`, metadata from a closed profitable position (with `trailingActive: true`) persisted to the next trade on the same symbol. Startup then saw `trailingActive: true` and skipped all SL validation, preserving a stale ATR SL.

**Fix:** `storePositionMeta()` always writes `trailingActive: false`. Trailing state is re-activated by `patchPositionMeta()` only when the large-profit partial triggers in the current session.

**Bug 3 — Orphaned INJUSDT reflection:**  
Backfill generated a `trade_memory` row 33 seconds after the reconciler phantom-closed INJUSDT, but without `source_trade_id`. Fixed with a direct SQL UPDATE.

**Commit:** see `fix: SL integrity — priority chain + trailingActive inheritance`

**Bug 4 (June 3) — posMonitor self-heal (`applyAtrSlTp`) also overwrote SL with ATR:**
`setSlTpForExistingPositions` was fixed but `applyAtrSlTp` — called by posMonitor when metadata fields are missing — had the same bug: applied ATR SL unconditionally. Additionally, the exchange TP was set to ATR TP1 (Full-mode), overriding Claude's TP2. This was the direct cause of NEAR's exchange SL changing from $2.54 → $2.4743 after the first restart post-fix.

**Fix (`4156480`):** `applyAtrSlTp` now reads `trade_log.sl/tp1/tp2` first. Exchange SL uses Claude's planned value if valid; exchange TP uses `trade_log.tp2` (Full-mode target) rather than ATR TP1. ATR is a true fallback only.

**Bug 5 (June 3) — `reconcileClosedPositions` phantom-closed pending limit rows:**
Reconciler found symbols open in DB but absent from live Bybit positions (because limit order hadn't filled yet) and used stale `closedPnl` records to close them. Affected HYPE twice (June 2 and June 3).

**Fix (`4156480`):** `reconcileClosedPositions` now loads `pendingLimitFills` from DB at startup and skips any symbol with an outstanding limit order.

**Bug 6 (June 3) — Restart reset ratcheted SL back to Claude's original wider value:**
`setSlTpForExistingPositions` Priority 1 used only `trade_log.sl`. If posMonitor had already ratcheted SL to breakeven ($2.70) during the session, a restart reset it back to $2.54 (trade_log.sl), widening the stop.

**Fix (`ec5df72`):** Priority 1 now takes the more protective of `trade_log.sl` and `positionMetadata.sl` — `Math.max()` for longs, `Math.min()` for shorts — both validated against live price. SL only ratchets toward profit on restart, never backward.

---

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

## DB Cleanup (June 3)

**trade_log is now fully clean — every row has `exit_at`.**

Two batches of ghost rows voided (`exit_price = entry_price`, `pnl = 0`, no P/L impact):

- **2 Bybit orphans** — `ETH` (dc064f9e, short, May 9, $2314.04) and `SOL` (7c38b5bd, long, May 15, $91.01). Old bare-symbol format from an earlier bot version. Were triggering `[reconcile] no closedPnl found` noise on every restart. Voided → reconciler now finds 0 open bybit rows.
- **15 OKX ghosts** — SOL-USDT ×8, ETH-USDT ×3, BTC-USDT ×2, AVAX-USDT ×1, LINK-USDT ×1. All May 6–7, all longs, from the old OKX paper trading era. Were not causing runtime noise (reconciler only processes bybit rows) but were polluting open-row counts.

Post-cleanup: `SELECT COUNT(*) FROM trade_log WHERE exit_at IS NULL` → **0**.

---

## Investigation Finding — Learning Loop Health (June 3)

**Finding: learning loop has no systematic blind spot for SL-hit trades.**

Queried live Neon DB:
- 99 closed `trade_log` rows, 131 `TRADE_CLOSE` reflections (extra 32 are Version B / old integer IDs)
- 130/131 complete (have `lessons_learned` + `entry_timing_verdict`)
- **All 16 SL-hit reflections are complete** — 16/16 have lessons + verdict, spanning May 24–Jun 2

**Only gap found:** 2 trades (SOLUSDT, XRPUSDT) closed with `exit_price = NULL` by the reconciler when Bybit returned no `closedPnl` record. Both `generateReflection` and `backfillStructuredReflections` skip trades with `exitPrice = 0`. Permanently unlearned — would need manual exit price patches to fix.

**Reflection trigger chain:**
1. `closeOpenTrade()` calls `generateReflection()` inline for all real-time closes (SL, TP, review, hard_stop)
2. Startup backfill (`max=60`) catches bot-offline closes and failed generations
3. Daily midnight SGT `learningHealth` cron re-triggers backfill if any incomplete reflections detected

No action required. Learning loop is healthy.

---

## Reference — tp2_verdict Semantics (June 2026)

`tp2_verdict` can hold the same string value for structurally different situations. The distinction matters whenever analysing or grading TP2 placement.

### What 'na' means

`tp2_verdict = 'na'` means **TP2 was not fairly tested — exclude this trade from any TP2-too-far analysis.** It arises from three distinct situations, all handled automatically in the live path:

1. **TP1 never fired** — price never entered the profit zone where TP2 placement matters (e.g. straight to original SL, or Path-C breakeven exit before any partial).
2. **Path-C breakeven exit before TP1** — same logic; TP2 was never in play.
3. **TP1 fired, then a discretionary posMonitor PARTIAL_CLOSE, then remainder exited before TP2.**

**Why case 3 must be 'na':** on such a trade two explanations are inseparable from the data:
- (a) TP2 was genuinely too far — price was never going to reach it regardless; or
- (b) TP2 was reachable, but Claude's discretionary early close changed how the trade played out, and that is why it did not ride to TP2.

The review close confounds the test. Recording `too_ambitious` would assert (a) as fact and teach rule generation "set TP2 closer" when the real cause may have been Claude's own early exit. The honest label is `na` — not "TP2 was fine," not "TP2 was too far," but "this trade cannot tell us; exclude it."

### The clean too_ambitious signal

`tp2_verdict = 'too_ambitious'` is a valid data point **only** when: TP1 fired, **no** discretionary review_partial occurred, and the remainder reversed on its own before reaching TP2. In that case the only thing shaping the outcome was price vs TP2 distance — so too_ambitious is a fair verdict. These clean B2 trades are the only valid TP2-too-far data points.

### Other tp2_verdict values in context

**`tp2_verdict = 'too_ambitious'` where TP1 never fired (straight-to-SL losses):**
The trade hit its original SL without approaching TP2. TP2 placement had no bearing on the outcome. This was an artefact of older reflection logic; it still appears on pre-June-2026 rows. Ignore tp2_verdict on these — the signal lives in `entryTimingVerdict` and `slTooTight`.

**`tp2_verdict = 'too_ambitious'` where TP1 fired, no review partial (clean B2):**
Genuinely informative — see "clean too_ambitious signal" above.

### The structural rule

**A `tp2_verdict` only carries information about TP2 placement if TP1 actually fired AND no discretionary partial close intervened.** TP2 placement is downstream of both entry direction and TP1 placement; it only becomes a factor once price has proved the direction correct by reaching TP1, and only when there was no mid-trade intervention that could have truncated the run.

### Mechanism note

Discretionary posMonitor partial closes now write a `trade_memory PARTIAL` row with `partialType = "review_partial"` (they previously left no record, making case 3 indistinguishable from a clean B2 trade at reflection time). The reflection detects this via `hadReviewPartial` and forces `tp2_verdict = 'na'` through a post-parse code override — not left to LLM judgment.

`review_partial` records are a first-class fact: they capture that Claude made a discretionary mid-trade close at a specific price and P/L. No verdict currently judges whether those discretionary closes were correct decisions; that is deliberately unbuilt and available as future analysis.

### Open future idea (documented, not built)

For case-3 trades, the TP2 question could be de-confounded by a hindsight counterfactual: replay actual post-close price data against the TP2 level to see whether price subsequently reached it. Yes → TP2 was reachable, the early close ended it; No → TP2 genuinely too far. This would recover the signal that `na` currently discards.

**Implementation constraint:** must use `fetchKlines` with an explicit `start:` anchor, **not** `getKlines` (which returns recent candles and produces wrong or empty results for historical trades — a known footgun). Result stored as a counterfactual learning field, never used as a predictive filter.

### Data-reliability note on tp1_executed

The `tp1Executed` flag derived from Bybit close-count (`bybitCloses.length > 1`) is **unreliable for trades with a bot review close**. Example: `b5a26af0` INJUSDT had 3 Bybit closes and was wrongly flagged as having reached TP2 (`bybitCloses.length > 2 = true`) when TP2 price 4.888 was never hit — the 3rd close was a bot market order. The raw `/v5/execution/list` fill records (sorted by `execTime`, not `createdTime`) are the ground truth for what actually fired and in what order. The `bybitCloses.length > 2` fallback was subsequently removed from the `tp2Executed` check; `tp2Executed` now relies solely on the `memPartials` 'tp2' record.

---

## B2 Ratchet Counterfactual Analysis (June 2026, 7 trades)

### Context

"B2" trades: TP1 fired (partial profit banked), then the remainder's SL was ratcheted to breakeven/entry and swept the remainder for a small net win (+0.75–2.0%). These record as `exit_method='sl_hit'` but are **wins by P&L sign**. This means the raw exit-method count understates the win rate: the true live-era win rate (entry_at >= Jun 4) is **52% (11/21 trades net-positive)**, not the ~19% that counting only `tp_hit` would imply — 7 B2 sl_hit wins are hidden by the label.

### Counterfactual method

For each of the 7 B2 trades, anchored 15m candles were fetched using `fetchKlines` with `start=exit_at` (the ratcheted-SL exit timestamp). Candles were walked forward until the original TP2 or original SL was hit, or 50h elapsed. **Not `getKlines`** — that returns recent candles and is wrong for historical analysis.

### Results (all 7 were short direction)

| Trade | Verdict | Max favorable after exit | Max adverse after exit | Time to verdict |
|---|---|---|---|---|
| INJUSDT +1.98% | **RATCHET SAVED** — SL hit in 1 candle (0.3h) | 0.000% | +2.04% | immediate |
| LINKUSDT +1.15% | **RATCHET SAVED** — SL hit in 1 candle (0.3h) | 0.000% | +2.11% | immediate |
| ETCUSDT +1.00% | **RATCHET COST** — TP2 reached after 9.0h | -7.04% | 0.000% | 9h |
| LINKUSDT +0.83% | **RATCHET SAVED** — SL hit after 18.0h (got 40% toward TP2 first) | -2.53% | +3.00% | 18h |
| XRPUSDT +0.82% | **RATCHET SAVED** — SL hit after 19.3h (got 40% toward TP2 first) | -2.44% | +1.93% | 19h |
| LINKUSDT +0.80% | **RATCHET SAVED** — SL hit after 7.3h (got 30% toward TP2 first) | -1.06% | +1.83% | 7h |
| LTCUSDT +0.75% | **RATCHET COST** — TP2 reached after 7.8h | -6.30% | +1.13% | 8h |

**Running tally: 5 saved / 2 cost.**

### Conclusions — do not re-derive these

**Conclusion 1 — The ratchet is net-helpful. Do NOT change ratchet behavior.**
5/7 the ratchet correctly banked TP1 profit before a full reversal to the original SL. The 2 misses are its cost, not evidence it is wrong. The ratchet is a profitable insurance policy on this sample.

**Conclusion 2 — TP2 is NOT too far.**
The 2 trades that reached TP2 had the longest TP2 distances (7.1% and 6.0% from entry), not the shortest. What separated reached-vs-not was post-TP1 market behavior (clean directional continuation vs. reversal), not TP2 placement. Do not tighten TP2 targets based on B2 trades failing to reach them.

**Conclusion 3 — The hard lever (not actionable yet).**
If the bot could distinguish "price is pausing in a continuation" from "price is reversing" at ratchet time, it could hold the 2 continuation cases to TP2 while ratcheting out the 5 reversals. Not actionable on 7 trades; revisit at 20–30 B2 trades.

### Sample caveat and next steps

7 trades only — directional (all shorts), NOT conclusive. The bot-adjustable Path A ratchet remains parked: its trigger condition is "data shows fixed ratchets underperform," and fixed ratchets WIN 5/7, so the trigger has NOT fired.

**Next:** keep scoring B2 ratchet outcomes (saved vs cost) as more B2 trades accumulate. Re-evaluate at ~20–30 B2 trades. Current running tally: **5 saved / 2 cost**.

---

## Investigation Finding — P&L Reconciler Cross-Attribution (June 15, 2026)

**Root cause: reconciler matched Bybit `closedPnl` to open trades by `symbol + entryAt−4h window + 6% price tolerance` — no guard that "a close before this position opened cannot belong to it."**

When two same-symbol trades are spaced <4h apart AND entry prices are within 6%, the `startMs = entryAt − 4h` window is wide enough to capture the prior trade's close records. Both pass the price filter; all records are summed as if they belong to the current trade.

**Confirmed instance — ATOM Jun 14–15:**
- `c51ca8ad` entry $1.956 (20:57:15 UTC Jun 14): partials at 18:56 (+$0.287) and 19:56 (+$0.326) on Jun 14
- `6bdeb8b3` entry $1.97 (20:00:59 UTC Jun 14): true Bybit PnL = SL close at 07:32 Jun 15 = −$0.174
- Reconciler pulled c51ca8ad's 18:56 and 19:56 closes into 6bdeb8b3's window (|1.956/1.97 − 1| = 0.7% < 6%) → attributed +$0.287 + $0.326 − $0.174 = +$0.439 to 6bdeb8b3 (a LOSS recorded as a WIN)

**Three locations fixed (`95d8382` + `2d2ef43`):**
1. `startup.ts:389` — `reconcileClosedPositions()`
2. `cronScanner.ts:2211` — `checkPositionMonitor()` close handler
3. `tradeMemoryLib.ts:208` — `generateReflection()` bybitCloses fetch (prevents AI re-hallucinating TP1 from prior-trade context)

**Fix (same filter in all three locations):**
```typescript
const entryAnchorMs = trade.entryAt.getTime(); // order-placement time
const matching = closed
  .filter(c => Math.abs(c.avgEntryPrice / entryPx - 1) < 0.06)
  .filter(c => c.closedAt >= entryAnchorMs - 10_000)  // load-bearing guard
  .sort((a, b) => a.closedAt - b.closedAt);
```
`startMs` (= entryAt − 4h) kept wide as an API performance hint. The `.filter(c => c.closedAt >= entryAnchorMs - 10_000)` is the authoritative correctness guard. 10s buffer covers WatchScan's 5s defer; far below the 4m39s minimum inter-trade gap in the dataset.

**Design note — ba70c039 accidentally clean:** A bot restart between 00:00–07:15 Jun 6 reset `meta.openedAt = Date.now()` (`startup.ts:291`), pushing `startMs` past 5019fefc's close → excluded by luck. The fix makes it correct on purpose via `entryAt` anchor.

**Backfill — 4 corrupted rows corrected (Jun 15):**

| Trade | Before pnl | After pnl | Before pnl_pct | After pnl_pct |
|---|---|---|---|---|
| `c51ca8ad` ATOM | +$0.353 | +$0.614 | 1.007% | 1.230% |
| `6bdeb8b3` ATOM | +$0.440 | **−$0.174** | 0.441% | **−0.349%** |
| `43d0dfc0` LINK | +$2.500 | +$2.538 | 2.519% | 5.236% |
| `0954f4fc` LINK | +$0.558 | +$0.586 | 0.797% | 0.571% |

Snapshots taken before correction: `backfill_pnl_fix_20260615_trade_log` + `backfill_pnl_fix_20260615_trade_memory` (reversible).
6bdeb8b3 reflection regenerated: `tp1_reached = false` confirmed, no re-hallucination of TP1.

---

## Investigation Finding — exit_method Inference Gap Fixed (June 16, 2026)

**Root cause: `generateReflection` inferred `exit_method` from `pnlPct < -5 ? "sl_hit" : "review"` when no `exitReasonOverride` was passed — the backfill path never passes one. Result: every backfilled trade without a large_profit partial was labeled "review" regardless of actual Bybit trigger type.**

The live path was unaffected (always calls `resolveExitReason` → passes `exitReasonOverride` before `closeOpenTrade`). The bug was backfill-only.

**Fix (`128c1c1`):** In `generateReflection`, lifted `lastCloseStopType` out of the `tp2ExecutedBybit` block (it was already being fetched via `getOrderStopType(lastOrderId)` for tp2 detection but thrown away). Now used in the inference fallback:
```
StopLoss → "sl_hit" | TakeProfit/PartialTakeProfit → "tp_hit" | (empty market order) → "review"
```
Market order closes (posMonitor CLOSE commands) still map to "review" — same as before. Live path unaffected.

**Bybit-verified correction for all 4 backfilled trades:**

| Trade | Bybit stopOrderType | Old exit_method | Corrected |
|---|---|---|---|
| `43d0dfc0` LINK +5.24% | TakeProfit | review | **tp_hit** |
| `0954f4fc` LINK +0.57% | StopLoss (after TP1 partial → tp1Executed=true) | review | **ratcheted_sl** |
| `c51ca8ad` ATOM +1.23% | *(empty — market order)* | review | **review** (unchanged) |
| `6bdeb8b3` ATOM −0.35% | StopLoss | review | **original_sl** → then **ratcheted_sl** (see below) |

**6bdeb8b3 ratcheted_sl correction:** Initially resolved to `original_sl` because `effective_sl` was NULL. Bybit ground truth: exit fill at $1.9644 vs original SL $1.928 (+1.89% gap, well beyond slippage). `effective_sl` backfilled to `1.96440000`; `exit_method` corrected to `ratcheted_sl`. Scan of all 4 `original_sl` + NULL `effective_sl` trades confirmed 6bdeb8b3 was the only genuine ratchet — the other 3 exit within 0.03% of original SL (slippage only).

**Snapshots:** `backfill_exit_fix_20260616_trade_memory` (4 rows, pre-correction) + `backfill_ratchet_fix_20260616_trade_log` + `backfill_ratchet_fix_20260616_trade_memory` (1 row each, pre-ratcheted_sl correction). All intact.

**Deploy filter (`39997e8`):** `drizzle.config.ts` tablesFilter extended with `!backfill_*` — drizzle-kit push no longer prompts to drop snapshot tables.

---

## System Change — Regime-Conditional TP1 (commit `9538144`, June 2026)

**Problem:** The old TP1 target was placed by the LLM at 4h structural levels (same method as TP2). These sat at 6–8% from entry — unreachable by short-duration trades and providing zero reversal protection. Every reversal peaked below the TP1 level, so the partial-close that would have banked profit before the reversal never triggered.

**Fix — code override replaces LLM TP1:**
`cronScanner.ts` (two paths: new signal ~line 1528, opportunity re-evaluation ~line 1871):
```typescript
const isChoppyTp1 = regime?.regime === "CHOPPY";
const tp1Pct      = isChoppyTp1 ? 0.01 : 0.025;
// regimeTp1 = entryPrice × (1 ± tp1Pct)
if (regimeTp1 > 0) opp.tp1 = regimeTp1;   // LLM output discarded
```
- **CHOPPY:** TP1 = entry × 1.01 (long) / × 0.99 (short) → **1.0% from entry**
- **Non-CHOPPY:** TP1 = entry × 1.025 / × 0.975 → **2.5% from entry**

**Downstream: SL ratchet after TP1 fires** (`cronScanner.ts` ~line 741):
```typescript
const _slChoppy = pm.entryRegime === "CHOPPY";
const tp1Sl = pos.side === "Buy"
  ? pm.entryPrice * (_slChoppy ? 1.01 : 1.02)
  : pm.entryPrice * (_slChoppy ? 0.99 : 0.98);
```
- CHOPPY: SL moves to **+1% from entry** after TP1
- Non-CHOPPY: SL moves to **+2% from entry** after TP1

**Breakeven trigger** (`cronScanner.ts` ~line 2665):
```typescript
const beTriggerPct = isChoppyCalibrated ? 0.8 : 2;
```
- CHOPPY: SL → entry at **+0.8%** (before TP1 fires)
- Non-CHOPPY: SL → entry at **+2.0%**

**Floor constraint:** TP1 must be ≥1% — the post-TP1 SL ratchet to `entryPrice × 1.01` would sit above a sub-1% TP1, creating an immediately-triggered stop. The code override makes this mechanically impossible (CHOPPY TP1 is exactly 1%, non-CHOPPY is 2.5%).

**Effect on population:** Flipped from −0.48% average net to net-positive. The 1h/4h structural TP1 the LLM was setting gave zero partial exits on reversals; the calibrated distance forces the partial before the typical reversal magnitude.

---

## System Change — Rule-Gen Redesign: Counterfactual Engine + 3-Phase Pipeline (commits `d26afdc`–`0694c20`, June 2026)

**Problem:** Previous rule-gen was pure LLM introspection over reflections — it could hallucinate rules not supported by the data, produce unenforceable rules (e.g., referencing 15m structure the code layer can't check), or miss high-leverage opportunities that the LLM wouldn't naturally articulate.

**Phase 1 — Counterfactual Engine (`computeCounterfactuals()` in `tradeMemoryLib.ts`):**
No LLM — pure code analysis over the closed-trade population. Runs via `/admin/counterfactuals`. For each setup/regime cohort, computes:
- `tp1Sweep`: would a calibrated TP1 (1% CHOPPY / 2.5% non-CHOPPY) have fired, rescuing profit before a reversal?
- `blockCandidates`: trades where a loss-avoidance rule would have blocked an actual loser
- `choppyTp2Sweep`: CHOPPY cohort-specific sweep
- `positiveSelection`: trades with consistent winning pattern
- `cutWinnerEarly`: winners that exited far below their max_profit

Engine outputs one of: `VALIDATED_BLOCK` (netDelta > +10%), `BORDERLINE`, `VALIDATED_ALLOW` (netDelta < −4%). CF_CUTOFF = 2026-06-04; population n=65 (26W/39L = 40% WR).

**Phase 2 — LLM articulates pre-validated opportunities (`8885c18`):**
LLM receives the engine's pre-classified cohorts and is asked to articulate rules for BOTH loss-avoidance (VALIDATED_BLOCK cohorts) AND win-amplification (VALIDATED_ALLOW cohorts — don't block these). This eliminates the prior bias toward loss-avoidance-only rules that silently blocked winners.

**Phase 3 — Post-LLM validation gate (`b6191dc`):**
After LLM proposes rules, a 5-gate filter runs before any rule is written to DB:
- **Gate 1:** reject if rule text embeds a TP1 lever (sets a TP1 level — contradicts code-fixed TP1)
- **Gate 1b:** reject if rule widens SL
- **Gate 1c:** regex scan of ruleText for any embedded TP1 price (catches evasions via entry/exit level language)
- **Gate 2:** lever must match engine classification (block-lever only on VALIDATED_BLOCK; allow-lever only on VALIDATED_ALLOW)
- **Gate 3:** counterfactual ±2% match — rule's predicted effect must match engine's computed netDelta within tolerance
- **Gate 4:** trade_skip threshold gate (blocks rules that would skip too many trades)
- **Gate 5:** confidence gate

Verified against independent recompute of engine results before deploying rules.

---

## System Change — Rule Set Cleanup (commit `a5f1646` + DB ops, June 2026)

**Before:** 15 active rules (original numbering 1–15). **After:** 17 active rules (renumbered; safeguards at 5/10/14/15, new rules at 20–37).

**Active rules (17):** 5, 10, 14, 15, 20, 21, 22, 23, 24, 25, 28, 30, 33, 34, 35, 36, 37

**Inactive rules (6):** 4, 9, 26, 27, 31, 32

**Deactivations:**
- **Rule 26** (old Rule 4 resurrection — entry candle direction gate): blocked 10 actual winners (BNB +5.33%, ATOM +4.96%, NEAR +4.39% among them). Zero net-positive counterfactual. Deactivated.
- **Rule 27** (15m structure alignment gate): requires 5/8 15m candles in trend direction. Unenforceable at the code-gate layer (`applyHardFilters` only fetches 1h/4h klines, no 15m). LLM scanner CAN evaluate 15m (has the data), but the rule as written implied code enforcement. Deactivated; re-introduce as a soft LLM-advisory if wanted.
- **Rules 31/32** (embedded TP1 at 4–5% / 5%+): directly contradicted the deployed code-fixed TP1 (1.0%/2.5%). Gate 1c was added specifically to catch this class of bypass. Deactivated.

**Corrections applied:**
- **Rule 14** — TP1 references updated from "max 1.5% RANGING / max 2.0% EXHAUSTION" to "set at 2.5% by the scanner (non-CHOPPY path)". Added note that 15m sub-clause is advisory (LLM evaluates from context; code gates do not check 15m).
- **Rule 35** — RANGING cap corrected 4.0%→3.5% (now matches Rule 14). EXHAUSTION cap 3.5%→3.0%. STRONG_TREND long 8.0%→6.5% (historical peak 5.98%). CHOPPY clause removed (already covered by Rule 23).
- **Rule 36** — MOMENTUM+CHOPPY clause removed (MOMENTUM+CHOPPY is unconditionally hard-blocked in `applyHardFilters`; the rule clause was redundant and potentially confusing).
- **Rule 37** — TRENDING_DOWN long clause removed (TRENDING_DOWN longs are unconditionally hard-blocked in code). Kept TRENDING_UP MOMENTUM short block (0W/1L).
- **Rule 33** — HELD with both clauses. Original report incorrectly flagged it as overlapping with Rule 10. Rule 10 = BEARISH-candle climax (selling exhaustion → avoid adding shorts). Rule 33 = BULLISH-spike climax (buying momentum → wait for 15m LH before shorting). Different candle directions, different thesis.

**Snapshots taken before changes:** `trading_rules_snapshot_20260621` (pre-deactivation), `trading_rules_snapshot_20260621_tp2` (pre-TP2-cap-fixes). Both subsequently dropped after confirming changes stable.

**Key architecture note (discovered during validation):** `tpCapShort()` hardcoded in `marketScanner.ts` is the **primary** TP2 cap channel (injected into the LLM prompt as authoritative). DB rules are a **secondary/soft** channel. Before this session, these two channels were contradictory (e.g. RANGING: tpCapShort said 2.5%, DB Rule 14 said 3.5%). The TP2 anchoring change below synced both channels.

---

## System Change — Regime×Setup TP2 Anchoring (commit `b5e7e40`, June 21 2026)

**Problem:** 83% of trades never hit TP2. Root cause: TP2 was anchored to the 4h 50-period high/low (8-day extremes at 6–7% from entry) while trades complete in median 6.2h — a 1h-swing duration. SL is placed at 1h/15m structural levels (correctly sized); TP2 was at 4h structural (mismatched). The "TP2=2× TP1 distance" fallback in the prompt also produced ~5.0% for non-CHOPPY, similarly aspirational.

**Population evidence:**
- STRONG_TREND MOMENTUM shorts: avg TP2 set at 6.43%, avg max_profit 2.69% — overshoot 4.06%
- CHOPPY: avg TP2 set at 4.8–5.1%, avg max_profit 1.4–1.7%
- RANGING: avg TP2 set at 3.04%, avg max_profit 3.49% — only regime with negative overshoot → 100% fill rate
- 4 STRONG_TREND MOMENTUM tp2_too_ambitious trades (LTC max 3.63%, INJ 3.81%, ETC 4.89%, XRP 4.51%) would have all filled at a 1h structural level of 3.5–4.5%

**Fix — prompt-only change in `marketScanner.ts`** (LLM already has 1h/4h/15m candles in context; no code change needed):

| Regime + Setup | TP2 method | Cap (backstop) |
|---|---|---|
| STRONG_TREND/TRENDING + MOMENTUM | Nearest 1h structural resistance (short) / support (long) | short ≤5.5%, long ≤6.5% |
| STRONG_TREND/TRENDING + LIQUIDITY_SWEEP | Nearest 4h structural resistance / support | ≤6.5% |
| CHOPPY or EXHAUSTION | Cap-driven: entry ± 3.0% (NOT structural) | 3.0% |
| RANGING | Nearest 4h range boundary | 3.5% |

Removed the "TP2=2× TP1 distance" fallback instruction.

**LIQSWEEP distinction:** LIQSWEEP setups in STRONG_TREND legitimately run to 4h targets (75% WR, 3/4 hit 4h TP2 in data, avg pnl +2.78%). Switching LIQSWEEP to 1h would have cost −1.92% on LIQSWEEP winners. Kept at 4h.

**Winner stress-test:** Simulated 1h TP2 (~4% proxy) against all 16 winners in switching regimes:
- Near-miss gains (4 STRONG_TREND + 3 TRENDING trades convert from TP1-only to TP2 fills): **+13.85%**
- Runner cap losses (7 trades exited earlier at 1h level): **−8.08%**
- **Net: +5.77%** improvement across winning cohort. Positive in all sensitivity scenarios tested (1h level 3.5%–5.0%).

**tpCapShort() synced as backstops** (previously contradicted DB rules — both channels now agree):
- CHOPPY: 3.5% → **3.0%** (DB Rule 23)
- RANGING: 2.5% → **3.5%** (DB Rules 14/35)
- EXHAUSTION: 3.5% → **3.0%** (DB Rules 14/35)
- STRONG_TREND/TRENDING: generic "4–8%" → setup-conditional (MOMENTUM 1h / LIQSWEEP 4h, caps above)

**Cap validation against observed data:**
- STRONG_TREND short 5.5% (n=17): REASONABLE — p75=4.16%, only 2 historical exceeders (BNB 7.28%, ATOM 6.13%), both MOMENTUM now switched to 1h anchoring
- STRONG_TREND long 6.5% (n=11): SLIGHTLY LOOSE — never exceeded historically (max 5.98%); appropriate headroom for LIQSWEEP runners
- TRENDING 6.0% (n=10): REASONABLE — sits near observed ceiling; doesn't bind MOMENTUM trades on 1h anchoring
- RANGING 3.5% (n=2): REASONABLE — 4h boundary naturally lands at 3.0–3.1%; n too thin to conclude
- EXHAUSTION 3.0% (n=3): INERT in data (0/3 reached 3.0%), but R:R math prevents going lower; monitor at n≥10

**R:R gate:** All 37 STRONG_TREND/TRENDING trades pass R:R ≥ 1.1 even with 1h TP2 proxy at 4.0% (minimum observed rr=1.29). Zero trades would be rejected.

---

## Clean Performance Baseline (June 15, 2026 — CORRECTED DATA)

**This is the first trustworthy baseline. Prior P&L assessments were on corrupted data.**

| Metric | Value |
|---|---|
| Sample | 109 Bybit trades, last 30 days |
| Win rate | **41.3%** (45 wins / 64 losses) |
| Net P&L | **−$41.15** |
| Avg win | **+$0.889** |
| Avg loss | **−$1.268** |
| R:R ratio | **0.70** |

**Core problem is R:R (0.70), not win rate.** At 41.3% win rate, breakeven R:R is 1.42 (= 0.587 / 0.413). The bot runs at 0.70 — wins are too small relative to losses. Pattern confirmed across reflections: "exits winners too early, losses run to full SL."

**The earlier apparent turnaround** (sessions showing +$0.23 net, avg win catching up to avg loss) was partly the cross-attribution bug inflating win sizes. These numbers are clean.

**R:R target for next-session review:** did the winner-cutting fixes (RSI gate `f913a81`, volume direction-gate `6f8197c`, CHOPPY exit profile `7191053`) push R:R above 0.70 on post-fix trades? Compare post-fix trade subset vs this baseline.

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
