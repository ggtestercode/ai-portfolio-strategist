-- Migration: add effective_sl column to trade_log
-- Run once against Railway PostgreSQL.
-- Column is nullable — existing rows are unaffected until a ratchet fires.

ALTER TABLE trade_log ADD COLUMN IF NOT EXISTS effective_sl NUMERIC(20, 8);
