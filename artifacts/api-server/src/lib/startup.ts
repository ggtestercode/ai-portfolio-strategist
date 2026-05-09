import { approvalGate }           from "./approvalGate";
import { openPosition }            from "../brokers/etoro";
import {
  openPosition    as bybitOpen,
  setOneWayMode   as bybitSetOneWayMode,
  getPositions    as bybitGetPositions,
  setStopLoss     as bybitSetStopLoss,
  setTakeProfit   as bybitSetTakeProfit,
} from "../brokers/bybit";
import { openPosition as okxOpen, testConnection, setPositionMode } from "../brokers/okx";
import { openPositionPaper }       from "../brokers/okxPaper";
import { sendApprovalRequest }     from "../notifications/telegram";
import { syncAllHoldingsToDB }     from "./aiResponder";
import { syncTotalCapitalToDB }    from "./brokerBalance";
import { llm }                     from "./llmRouter";

export let okxPaperMode = false;

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

    // Apply default SL/TP when the caller (e.g. assistant) didn't provide them
    if (!p.stopLossPrice || !p.takeProfitPrice) {
      const e      = result.entryPrice;
      const posIdx = result.positionIdx;
      const sl     = isShort ? +(e * 1.08).toFixed(4) : +(e * 0.92).toFixed(4);
      const tp     = isShort ? +(e * 0.85).toFixed(4) : +(e * 1.15).toFixed(4);
      if (!p.stopLossPrice)   await bybitSetStopLoss(p.symbol,   sl, posIdx).catch(e2 => console.warn(`[startup] default SL ${p.symbol}:`, e2.message));
      if (!p.takeProfitPrice) await bybitSetTakeProfit(p.symbol, tp, posIdx).catch(e2 => console.warn(`[startup] default TP ${p.symbol}:`, e2.message));
      console.log(`[startup] Applied default SL/TP for ${p.symbol} ${isShort ? "short" : "long"}: SL=$${sl} TP=$${tp} posIdx=${posIdx}`);
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
