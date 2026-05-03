import { approvalGate }        from "./approvalGate";
import { openPosition }         from "../brokers/etoro";
import { placeOrder }           from "../brokers/bybit";
import { openPosition as okxOpen } from "../brokers/okx";
import { sendApprovalRequest }  from "../notifications/telegram";
import { scheduleScan }         from "./marketScanner";
import { checkAndRebalance }    from "./rebalancer";

export function initBrokers(): void {
  approvalGate.registerExecutor("etoro", async (p) => {
    const result = await openPosition(p.symbol, p.amountUsd, p.side === "buy");
    return { orderId: result.positionId };
  });

  approvalGate.registerExecutor("bybit", async (p) => {
    const result = await placeOrder(
      p.symbol,
      p.side === "buy" ? "Buy" : "Sell",
      p.amountUsd,
    );
    return { orderId: result.orderId };
  });

  approvalGate.registerExecutor("okx", async (p) => {
    const result = await okxOpen(p.symbol, p.side, p.amountUsd);
    return { orderId: result.orderId };
  });

  approvalGate.registerNotifier(sendApprovalRequest);

  scheduleScan();
  checkAndRebalance().catch(e => console.error("[startup] Initial rebalance check failed:", e));

  console.log("[startup] Broker executors registered: etoro, bybit, okx");
  console.log("[startup] Telegram notifier registered");
}
