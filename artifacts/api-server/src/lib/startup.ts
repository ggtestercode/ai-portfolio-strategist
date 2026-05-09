import { approvalGate }           from "./approvalGate";
import { openPosition }            from "../brokers/etoro";
import { openPosition as bybitOpen, setOneWayMode as bybitSetOneWayMode } from "../brokers/bybit";
import { openPosition as okxOpen, testConnection, setPositionMode } from "../brokers/okx";
import { openPositionPaper }       from "../brokers/okxPaper";
import { sendApprovalRequest }     from "../notifications/telegram";
import { syncAllHoldingsToDB }     from "./aiResponder";
import { syncTotalCapitalToDB }    from "./brokerBalance";

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
    // p.amountUsd = margin (capital at risk); notional = margin × leverage
    const result = await bybitOpen(p.symbol, p.side === "buy" ? "Buy" : "Sell", p.amountUsd * leverage, leverage);
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

  console.log("[startup] Broker executors registered: etoro, bybit, okx");
  console.log("[startup] Telegram notifier registered");
}
