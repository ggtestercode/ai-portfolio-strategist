-- Migration: add tp2_progress_pct to trade_memory
-- DO NOT run automatically — review and run manually against Railway PostgreSQL.
--
-- Measures how far price traveled into the TP1→TP2 corridor before the trade ended.
--   0.00 = price never progressed past TP1 toward TP2
--   1.00 = price reached TP2
--   0.87 = price covered 87% of the TP1→TP2 gap then reversed
--   NULL = TP1 never fired, or TP1/TP2 not set (corridor undefined)
--
-- Populated at live reflection time from tradePeriodCandles (full hold window).
-- Not used in any verdict or prompt — pure measurement for later analysis.
--
-- Optional future backfill for existing rows (SQL-only, no Bybit/LLM):
--   UPDATE trade_memory tm
--   SET tp2_progress_pct = ROUND(LEAST(1, GREATEST(0,
--       (tm.max_profit_pct::numeric - ABS(tl.tp1::numeric - tl.entry_price::numeric) / tl.entry_price::numeric * 100)
--       / (ABS(tl.tp2::numeric - tl.entry_price::numeric) / tl.entry_price::numeric * 100
--          - ABS(tl.tp1::numeric - tl.entry_price::numeric) / tl.entry_price::numeric * 100)
--   )), 4)
--   FROM trade_log tl
--   WHERE tl.id::text = tm.source_trade_id
--     AND tm.action = 'TRADE_CLOSE'
--     AND tm.tp2_progress_pct IS NULL
--     AND tm.max_profit_pct IS NOT NULL
--     AND tm.max_profit_pct::numeric > 0          -- exclude backfilled rows (unanchored getKlines = 0)
--     AND tl.tp1 IS NOT NULL AND tl.tp2 IS NOT NULL AND tl.entry_price IS NOT NULL
--     AND ABS(tl.tp2::numeric - tl.entry_price::numeric) - ABS(tl.tp1::numeric - tl.entry_price::numeric) > 0;

ALTER TABLE trade_memory ADD COLUMN IF NOT EXISTS tp2_progress_pct NUMERIC(10, 4);

-- Verify:
SELECT COUNT(*) AS total_rows,
       COUNT(tp2_progress_pct) AS rows_with_value
FROM trade_memory
WHERE action = 'TRADE_CLOSE';
