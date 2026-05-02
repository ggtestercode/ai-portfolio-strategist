import { db } from "@workspace/db";
import {
  profileTable,
  holdingsTable,
  targetAllocationsTable,
  tradeSuggestionsTable,
  transactionsTable,
  riskAlertsTable,
  assistantMessagesTable,
} from "@workspace/db";

async function main() {
  // Wipe
  await db.delete(assistantMessagesTable);
  await db.delete(riskAlertsTable);
  await db.delete(transactionsTable);
  await db.delete(tradeSuggestionsTable);
  await db.delete(targetAllocationsTable);
  await db.delete(holdingsTable);
  await db.delete(profileTable);

  // Profile (single user)
  await db.insert(profileTable).values({
    name: "Alex Morgan",
    email: "alex@portfolio.ai",
    avatarUrl: null,
    totalCapital: 110000,
    targetReturnPct: 50,
    timeHorizonMonths: 1,
    riskTolerance: "extreme",
    strategyType: "aggressive-momentum",
    strategyRiskLevel: "Extreme",
    strategyKeyRules: [
      "High conviction momentum plays only",
      "Max leverage: 50x crypto, 20x stocks",
      "Target 50% return per month",
      "Never hold losing positions — cut fast",
      "Concentrate in top 1-2 ideas",
    ],
    maxLeverageCrypto: 50,
    maxLeverageStocks: 20,
    notes: "High conviction momentum plays only. Accepts full capital loss risk.",
    strategyLastGenerated: new Date(Date.now() - 1000 * 60 * 60 * 12),
  });

  // Target allocations (sums to 100)
  await db.insert(targetAllocationsTable).values([
    { assetClass: "Crypto", targetPct: 40 },
    { assetClass: "Equities", targetPct: 30 },
    { assetClass: "ETFs", targetPct: 15 },
    { assetClass: "Cash", targetPct: 10 },
    { assetClass: "Commodities", targetPct: 5 },
  ]);

  // Holdings
  await db.insert(holdingsTable).values([
    // Crypto (~46% of ~$128k total → drifted high)
    { symbol: "BTC", name: "Bitcoin", assetClass: "Crypto", quantity: 0.62, price: 67340, change24hPct: 1.84 },
    { symbol: "ETH", name: "Ethereum", assetClass: "Crypto", quantity: 6.4, price: 3580, change24hPct: 2.91 },
    { symbol: "SOL", name: "Solana", assetClass: "Crypto", quantity: 24, price: 188, change24hPct: -0.62 },
    // Equities (~28%)
    { symbol: "AAPL", name: "Apple Inc.", assetClass: "Equities", quantity: 65, price: 188.4, change24hPct: 0.74 },
    { symbol: "MSFT", name: "Microsoft Corp.", assetClass: "Equities", quantity: 32, price: 426.1, change24hPct: 1.12 },
    { symbol: "NVDA", name: "NVIDIA Corp.", assetClass: "Equities", quantity: 8, price: 882.3, change24hPct: 3.41 },
    // ETFs (~13%)
    { symbol: "VOO", name: "Vanguard S&P 500", assetClass: "ETFs", quantity: 28, price: 482.5, change24hPct: 0.41 },
    { symbol: "QQQ", name: "Invesco QQQ Trust", assetClass: "ETFs", quantity: 6, price: 478.2, change24hPct: 0.66 },
    // Cash (~8%) - using "USD" as the symbol
    { symbol: "USD", name: "US Dollar", assetClass: "Cash", quantity: 10500, price: 1, change24hPct: 0 },
    // Commodities (~5%)
    { symbol: "GLD", name: "SPDR Gold Trust", assetClass: "Commodities", quantity: 28, price: 218.4, change24hPct: -0.21 },
  ]);

  // Trade suggestions
  await db.insert(tradeSuggestionsTable).values([
    {
      symbol: "ETH",
      pair: "ETH/USDT",
      side: "Buy",
      status: "Open",
      entryRangeLow: 3450,
      entryRangeHigh: 3580,
      target: 4100,
      stopLoss: 3280,
      positionSize: "5% of portfolio",
      suggestedAction: "Scale in 50% now, 50% on retest",
      reasoning:
        "Bullish momentum continuation after breakout above 3500. Volume confirms.",
      riskWarning:
        "Macro volatility could trigger stop-loss; size carefully.",
      summary: "Bullish setup on ETH following breakout, target +14% upside.",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 3),
    },
    {
      symbol: "SOL",
      pair: "SOL/USDT",
      side: "Hold",
      status: "Open",
      entryRangeLow: 178,
      entryRangeHigh: 198,
      target: 240,
      stopLoss: 165,
      positionSize: "Maintain 4%",
      suggestedAction: "No action — already exposed",
      reasoning:
        "Position sits near upper end of accumulation. Wait for pullback.",
      riskWarning: "Re-evaluate if SOL closes below 170 on daily.",
      summary: "Hold existing position; wait for cleaner re-entry.",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 18),
    },
    {
      symbol: "NVDA",
      pair: "NVDA",
      side: "Sell",
      status: "Open",
      entryRangeLow: 880,
      entryRangeHigh: 920,
      target: 760,
      stopLoss: 945,
      positionSize: "Trim 25% of position",
      suggestedAction: "Take partial profit, reset cost basis",
      reasoning:
        "Overbought RSI, position now 8% of portfolio (above 5% guideline).",
      riskWarning: "Earnings volatility upcoming — partial sell de-risks.",
      summary: "Trim 25% of NVDA on overextension; lock in gains.",
      createdAt: new Date(Date.now() - 1000 * 60 * 60 * 36),
    },
  ]);

  // Transactions (last ~30 days)
  const now = Date.now();
  const day = 1000 * 60 * 60 * 24;
  await db.insert(transactionsTable).values([
    { occurredAt: new Date(now - 1 * day - 1000 * 60 * 90), type: "Buy", asset: "ETH", amount: 1.5, value: -5340, status: "Completed", note: "AI suggestion: scale-in 50%" },
    { occurredAt: new Date(now - 2 * day), type: "Dividend", asset: "VOO", amount: 0, value: 124.32, status: "Completed", note: "Quarterly dividend" },
    { occurredAt: new Date(now - 3 * day), type: "Sell", asset: "NVDA", amount: -2, value: 1748, status: "Completed", note: "Trim on overextension" },
    { occurredAt: new Date(now - 6 * day), type: "Rebalance", asset: "Cash", amount: 2500, value: 2500, status: "Completed", note: "Auto-rebalance into reserves" },
    { occurredAt: new Date(now - 8 * day), type: "Buy", asset: "BTC", amount: 0.05, value: -3220, status: "Completed", note: "Weekly DCA" },
    { occurredAt: new Date(now - 11 * day), type: "Buy", asset: "AAPL", amount: 5, value: -940, status: "Completed", note: null },
    { occurredAt: new Date(now - 14 * day), type: "Deposit", asset: "USD", amount: 10000, value: 10000, status: "Completed", note: "Funding deposit" },
    { occurredAt: new Date(now - 17 * day), type: "Buy", asset: "GLD", amount: 4, value: -870, status: "Completed", note: "Inflation hedge" },
    { occurredAt: new Date(now - 20 * day), type: "Sell", asset: "MSFT", amount: -3, value: 1245, status: "Completed", note: "Profit take" },
    { occurredAt: new Date(now - 25 * day), type: "Rebalance", asset: "QQQ", amount: 1, value: -478, status: "Completed", note: "Allocation drift correction" },
    { occurredAt: new Date(now - 28 * day), type: "Withdraw", asset: "USD", amount: -2000, value: -2000, status: "Completed", note: "Quarterly withdrawal" },
    { occurredAt: new Date(now - 32 * day), type: "Dividend", asset: "AAPL", amount: 0, value: 41.2, status: "Completed", note: null },
    { occurredAt: new Date(now - 1000 * 60 * 30), type: "Buy", asset: "SOL", amount: 4, value: -752, status: "Pending", note: "Limit order pending fill" },
  ]);

  // Risk alerts
  await db.insert(riskAlertsTable).values([
    {
      severity: "Warning",
      title: "Crypto allocation above target",
      message:
        "Your crypto exposure is currently 46.2% vs the 40% target. Consider rebalancing.",
      dismissed: false,
      createdAt: new Date(now - 1000 * 60 * 45),
    },
    {
      severity: "Critical",
      title: "Single-position concentration risk",
      message:
        "NVDA represents over 7% of total portfolio value. Strategy guideline is 5% max per position.",
      dismissed: false,
      createdAt: new Date(now - 1000 * 60 * 60 * 4),
    },
    {
      severity: "Info",
      title: "Strategy refresh recommended",
      message:
        "Your last strategy generation was 12 hours ago. Markets have moved 1.8% since.",
      dismissed: false,
      createdAt: new Date(now - 1000 * 60 * 60 * 6),
    },
    {
      severity: "Warning",
      title: "Stop-loss approaching",
      message:
        "SOL position is within 7% of suggested stop-loss at $165.",
      dismissed: true,
      createdAt: new Date(now - 1000 * 60 * 60 * 26),
    },
  ]);

  // Assistant messages
  await db.insert(assistantMessagesTable).values([
    {
      role: "user",
      content: "How is my portfolio performing this month?",
      createdAt: new Date(now - 1000 * 60 * 60 * 5),
    },
    {
      role: "assistant",
      content:
        "Your portfolio is up about 4.2% over the last 30 days, outperforming the benchmark by roughly 1.6%. The main contributor is crypto, which has run hot — that's also why you're sitting above your target allocation.",
      createdAt: new Date(now - 1000 * 60 * 60 * 5 + 3000),
    },
    {
      role: "user",
      content: "Should I take profits on NVDA?",
      createdAt: new Date(now - 1000 * 60 * 60 * 4),
    },
    {
      role: "assistant",
      content:
        "Yes — trimming 25% would bring NVDA back near your 5% position-size guideline and lock in solid gains. I've added a Sell suggestion to your Trade Assistant panel with target $760 and stop $945.",
      createdAt: new Date(now - 1000 * 60 * 60 * 4 + 4000),
    },
  ]);

  console.log("Seed complete.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
