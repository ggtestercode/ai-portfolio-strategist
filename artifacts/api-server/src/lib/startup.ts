import { approvalGate }           from "./approvalGate";
import { openPosition }            from "../brokers/etoro";
import {
  openPosition    as bybitOpen,
  setOneWayMode   as bybitSetOneWayMode,
  getPositions    as bybitGetPositions,
  setStopLoss     as bybitSetStopLoss,
  setTakeProfit   as bybitSetTakeProfit,
  getKlines,
  getFundingRate,
  getOpenInterest,
} from "../brokers/bybit";
import { openPosition as okxOpen, testConnection, setPositionMode } from "../brokers/okx";
import { openPositionPaper }       from "../brokers/okxPaper";
import { sendApprovalRequest, sendAlert } from "../notifications/telegram";
import { syncAllHoldingsToDB }     from "./aiResponder";
import { syncTotalCapitalToDB }    from "./brokerBalance";
import { llm }                     from "./llmRouter";

export let okxPaperMode = false;

// ── Inline technical helpers (no dep on marketScanner) ────────────────────────
function calcRSI(closes: number[], period = 14): number {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = closes.length - period; i < closes.length; i++) {
    const diff = (closes[i] ?? 0) - (closes[i - 1] ?? 0);
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + (gains / period) / avgLoss);
}

function calcEMA(closes: number[], period: number): number {
  if (closes.length < period) return closes[closes.length - 1] ?? 0;
  const k = 2 / (period + 1);
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period;
  for (let i = period; i < closes.length; i++) ema = (closes[i]! * k) + (ema * (1 - k));
  return ema;
}

// ── Claude-decided SL/TP for manual trades ───────────────────────────────────
async function applyClaudeSlTp(
  symbol:      string,
  direction:   "long" | "short",
  entryPrice:  number,
  positionIdx: number,
): Promise<void> {
  // Gather market data in parallel
  const [klines1h, klines4h, fr, oi] = await Promise.allSettled([
    getKlines(symbol, "60",  50),
    getKlines(symbol, "240", 50),
    getFundingRate(symbol),
    getOpenInterest(symbol),
  ]);

  function summarise(label: string, klines: typeof klines1h): string {
    if (klines.status !== "fulfilled") return `${label}: unavailable`;
    const closes = klines.value.map(k => k.close);
    const last   = closes[closes.length - 1]?.toFixed(4) ?? "?";
    const rsi    = calcRSI(closes).toFixed(1);
    const ema20  = calcEMA(closes, 20).toFixed(4);
    const ema50  = calcEMA(closes, 50).toFixed(4);
    return `${label}: price=$${last} RSI=${rsi} EMA20=$${ema20} EMA50=$${ema50}`;
  }

  const frVal  = fr.status === "fulfilled" ? fr.value : { rate: 0, nextFundingTime: 0 };
  const oiVal  = oi.status === "fulfilled" ? oi.value : 0;
  const frSign = frVal.rate >= 0 ? "+" : "";
  const oiStr  = oiVal > 1e9 ? `${(oiVal / 1e9).toFixed(2)}B` : oiVal > 1e6 ? `${(oiVal / 1e6).toFixed(1)}M` : oiVal.toFixed(0);

  const prompt = [
    `Position just opened:`,
    `Symbol: ${symbol}`,
    `Direction: ${direction}`,
    `Entry: $${entryPrice.toFixed(4)}`,
    ``,
    `Market data:`,
    summarise("1h", klines1h),
    summarise("4h", klines4h),
    `Funding rate: ${frSign}${(frVal.rate * 100).toFixed(4)}%`,
    `Open interest: ${oiStr}`,
    ``,
    `Decide stop loss and take profit.`,
    `Hard limit: SL cannot exceed 40% from entry (max SL for ${direction}: $${direction === "short" ? (entryPrice * 1.40).toFixed(4) : (entryPrice * 0.60).toFixed(4)}).`,
    `No other restrictions — use your best judgment based on the market structure.`,
    `Return JSON: {"stopLoss": <price>, "takeProfit": <price>, "method": "<string>", "reasoning": "<1 sentence>"}`,
  ].join("\n");

  const res = await llm.json<{ stopLoss: number; takeProfit: number; method: string; reasoning: string }>({
    taskType:      "trade_decision",
    systemContext: "You are a trading risk manager. Set precise stop-loss and take-profit prices for a live futures position. Respond JSON only.",
    prompt,
    schema: {
      type: "object", required: ["stopLoss", "takeProfit", "method", "reasoning"],
      properties: {
        stopLoss:  { type: "number" },
        takeProfit: { type: "number" },
        method:    { type: "string" },
        reasoning: { type: "string" },
      },
    },
    fallback: { stopLoss: 0, takeProfit: 0, method: "failed", reasoning: "Claude call failed" },
  }).catch(() => ({ data: { stopLoss: 0, takeProfit: 0, method: "error", reasoning: "error" }, parseSuccess: false }));

  const { stopLoss: sl, takeProfit: tp, method, reasoning } = res.data;

  if (sl > 0) await bybitSetStopLoss(symbol,   sl, positionIdx).catch(e => console.warn(`[startup] SL ${symbol}:`, e.message));
  if (tp > 0) await bybitSetTakeProfit(symbol, tp, positionIdx).catch(e => console.warn(`[startup] TP ${symbol}:`, e.message));

  console.log(`[startup] Claude SL/TP for ${symbol} ${direction}: SL=$${sl} TP=$${tp} (${method})`);

  await sendAlert([
    `🛡️ <b>SL/TP set for ${symbol} ${direction}</b>`,
    `SL: $${sl > 0 ? sl.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}`,
    `TP: $${tp > 0 ? tp.toLocaleString("en-US", { maximumFractionDigits: 4 }) : "—"}`,
    `Method: ${method}`,
    `<i>${reasoning}</i>`,
  ].join("\n")).catch(() => {});
}

export async function initBrokers(): Promise<void> {
  approvalGate.registerExecutor("etoro", async (p) => {
    const symbol = p.symbol.replace(/[-/]?(USDT|USDC|USD)$/i, "");
    const result = await openPosition(symbol, p.amountUsd, p.side === "buy");
    return { orderId: result.positionId };
  });

  await bybitSetOneWayMode().catch(e => console.warn("[startup] Bybit set-one-way-mode failed:", e.message));

  approvalGate.registerExecutor("bybit", async (p) => {
    const leverage = 10;
    const bSide    = p.side === "buy" ? "Buy" : "Sell";
    const isShort  = bSide === "Sell";

    const result = await bybitOpen(p.symbol, bSide, p.amountUsd * leverage, leverage, {
      stopLoss:   p.stopLossPrice,
      takeProfit: p.takeProfitPrice,
    });

    // Ask Claude to decide SL/TP from live market data when caller didn't provide them
    if (!p.stopLossPrice || !p.takeProfitPrice) {
      applyClaudeSlTp(p.symbol, isShort ? "short" : "long", result.entryPrice, result.positionIdx)
        .catch(e2 => console.warn(`[startup] applyClaudeSlTp ${p.symbol}:`, e2.message));
    }

    return { orderId: result.orderId };
  });

  // Probe OKX credentials; fall back to paper trading if keys are invalid
  const { ok } = await testConnection().catch(() => ({ ok: false }));
  if (ok) {
    await setPositionMode("long_short_mode").catch(e =>
      console.warn("[startup] OKX set-position-mode failed:", e.message)
    );
    approvalGate.registerExecutor("okx", async (p) => {
      const result = await okxOpen(p.symbol, p.side, p.amountUsd);
      return { orderId: result.orderId };
    });
    console.log("[startup] OKX: live API keys verified ✅");
  } else {
    okxPaperMode = true;
    approvalGate.registerExecutor("okx", async (p) => {
      const result = await openPositionPaper(p.symbol, p.side, p.amountUsd);
      return { orderId: result.orderId };
    });
    console.log("[startup] OKX: keys rejected — paper trading mode activated 📄");
  }

  approvalGate.registerNotifier(sendApprovalRequest);

  // Sync live broker positions and capital balance into DB
  syncAllHoldingsToDB().catch(e => console.error("[startup] Holdings sync failed:", e));
  syncTotalCapitalToDB().catch(e => console.error("[startup] Capital sync failed:", e));

  // Set SL/TP for any existing positions that don't have them
  setSlTpForExistingPositions().catch(e => console.error("[startup] SL/TP setup failed:", e));

  console.log("[startup] Broker executors registered: etoro, bybit, okx");
  console.log("[startup] Telegram notifier registered");
}

async function setSlTpForExistingPositions(): Promise<void> {
  const positions = await bybitGetPositions().catch(() => []);
  if (!positions.length) return;

  for (const pos of positions) {
    const hasSl = pos.stopLoss  && pos.stopLoss  > 0;
    const hasTp = pos.takeProfit && pos.takeProfit > 0;
    if (hasSl && hasTp) {
      console.log(`[startup] ${pos.symbol} already has SL=${pos.stopLoss} TP=${pos.takeProfit} — skipping`);
      continue;
    }

    const res = await llm.json<{ stopLoss: number; takeProfit: number; method: string }>({
      taskType: "trade_decision",
      systemContext: "You are a risk manager. Set stop-loss and take-profit for a live Bybit futures position. Respond JSON only.",
      prompt: [
        `Position: ${pos.symbol} ${pos.side} ${pos.leverage}x`,
        `Entry: $${pos.entryPrice} | P/L: ${pos.pnl >= 0 ? "+" : ""}$${pos.pnl.toFixed(2)} (${pos.pnlPct.toFixed(2)}%)`,
        pos.stopLoss  ? `Existing SL: $${pos.stopLoss}`  : "No SL set",
        pos.takeProfit ? `Existing TP: $${pos.takeProfit}` : "No TP set",
        ``,
        `Set realistic SL (5-10% from entry) and TP (10-20% from entry) for this ${pos.leverage}x position.`,
        `Return: {"stopLoss": <price>, "takeProfit": <price>, "method": "percent|swing_low|ATR"}`,
      ].join("\n"),
      schema: {
        type: "object", required: ["stopLoss", "takeProfit", "method"],
        properties: { stopLoss: { type: "number" }, takeProfit: { type: "number" }, method: { type: "string" } },
      },
      fallback: { stopLoss: 0, takeProfit: 0, method: "percent" },
    }).catch(() => ({ data: { stopLoss: 0, takeProfit: 0, method: "percent" }, parseSuccess: false }));

    if (!hasSl && res.data.stopLoss > 0) {
      await bybitSetStopLoss(pos.symbol, res.data.stopLoss, pos.positionIdx)
        .catch(e => console.warn(`[startup] SL ${pos.symbol}: ${e.message}`));
    }
    if (!hasTp && res.data.takeProfit > 0) {
      await bybitSetTakeProfit(pos.symbol, res.data.takeProfit, pos.positionIdx)
        .catch(e => console.warn(`[startup] TP ${pos.symbol}: ${e.message}`));
    }
    console.log(`[startup] SL/TP set for ${pos.symbol}: SL=$${res.data.stopLoss} TP=$${res.data.takeProfit} (${res.data.method})`);
  }
}
