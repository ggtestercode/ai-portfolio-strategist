import { approvalGate } from "./approvalGate";
import { openPosition }  from "../brokers/etoro";
import { placeOrder }    from "../brokers/bybit";

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

  console.log("[startup] Broker executors registered: etoro, bybit");
}
