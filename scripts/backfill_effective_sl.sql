-- Backfill effective_sl for the 6 known profit-protected exits (post-TP1 SL ratchet).
-- All are Bybit shorts. Ratcheted SL = entry_price * 0.99 (1% beyond entry for shorts).
-- Run AFTER migrate_effective_sl.sql.
-- Safe to re-run (WHERE effective_sl IS NULL prevents double-update).
--
-- Identified trades (entry_at >= 2026-06-04, broker=bybit, exit_method=sl_hit, pnl_pct > 0):
--   ETCUSDT   +1.00%   Jun 5 04:01 UTC
--   LTCUSDT   +0.75%   Jun 5 16:00 UTC
--   XRPUSDT   +0.82%   Jun 6 00:00 UTC
--   INJUSDT   +1.98%   Jun 6 12:00 UTC  (LIQUIDITY_SWEEP)
--   LINKUSDT  +1.15%   Jun 7 12:00 UTC
--   LINKUSDT  +0.80%   Jun 8 00:01 UTC

UPDATE trade_log
SET effective_sl = ROUND(entry_price::NUMERIC * 0.99, 8)
WHERE broker = 'bybit'
  AND direction = 'short'
  AND effective_sl IS NULL
  AND exit_at IS NOT NULL
  AND pnl_pct::NUMERIC > 0
  AND entry_at >= '2026-06-04 00:00:00+00'
  AND id IN (
    SELECT tl.id
    FROM trade_log tl
    JOIN trade_memory tm ON tl.id::text = tm.source_trade_id
    WHERE tm.exit_method = 'sl_hit'
      AND tl.pnl_pct::NUMERIC > 0
      AND tl.broker = 'bybit'
      AND tl.entry_at >= '2026-06-04 00:00:00+00'
  );

-- Verify: should return 6 rows
SELECT id, symbol, entry_at::date, pnl_pct, entry_price, effective_sl,
       ROUND((entry_price::NUMERIC - effective_sl::NUMERIC) / entry_price::NUMERIC * 100, 2) AS effective_sl_dist_pct
FROM trade_log
WHERE effective_sl IS NOT NULL
ORDER BY entry_at;
