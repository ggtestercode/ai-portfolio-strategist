/**
 * aiResponder.ts — Drop-in replacement
 * Same generateAssistantReply signature. Now uses Claude via llmRouter.
 */

import { llm, type TaskType } from "./llmRouter";
import { cache, TTL, CacheKey } from "./contextCache";
import { approvalGate, buildProposal } from "./approvalGate";
import { db, profileTable, holdingsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { closePosition as etoroClose, getPortfolio } from "../brokers/etoro";
import { closePosition as okxClose, closeByUnits as okxCloseByUnits, getPositions as okxGetPositions, openLimitPosition as okxOpenLimit, openPosition as okxOpenSpot } from "../brokers/okx";
import { closePositionPaper, getPositionsPaper } from "../brokers/okxPaper";
import {
  getTicker    as bybitGetTicker,
  getPositions as bybitGetPositions,
  openLimitPosition   as bybitOpenLimit,
  closePartialByAmount as bybitClosePartial,
  closePercentPosition as bybitClosePercent,
  closePosition        as bybitClose,
} from "../brokers/bybit";
import { okxPaperMode } from "./startup";
import { logOpenTrade, closeOpenTrade } from "./tradeMemoryLib";

interface EtoroPos {
  positionId?: string | number;
  symbol?: string;
  investedAmount?: number;
  profit?: number;
  isBuy?: boolean;
  assetClass?: string;
}
interface EtoroPortfolio { positions?: EtoroPos[]; [k: string]: unknown; }

export async function syncHoldingsFromEtoro(): Promise<void> {
  const portfolio = (await getPortfolio()) as EtoroPortfolio;
  const positions = portfolio?.positions ?? [];
  await db.delete(holdingsTable);
  for (const p of positions) {
    if (!p.symbol) continue;
    const value = p.investedAmount ?? 0;
    await db.insert(holdingsTable).values({
      symbol:       p.symbol.toUpperCase(),
      name:         p.symbol.toUpperCase(),
      assetClass:   p.assetClass ?? "Equity",
      quantity:     value,
      price:        1,
      change24hPct: p.profit && p.investedAmount
        ? (p.profit / p.investedAmount) * 100
        : 0,
    });
  }
}

// ── Market hours ─────────────────────────────────────────────────────────────

const CRYPTO_ASSET_CLASSES = new Set(["Crypto", "crypto"]);

function isMarketOpen(assetClass: string): boolean {
  if (CRYPTO_ASSET_CLASSES.has(assetClass)) return true; // 24/7
  const now = new Date();
  const day = now.getUTCDay(); // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false;
  // US EDT = UTC-4 (Mar–Nov). Market: 9:30 AM–4:00 PM ET = 13:30–20:00 UTC
  const utcMinutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  return utcMinutes >= 810 && utcMinutes < 1200; // 13:30–20:00 UTC
}

function nextOpenStr(assetClass: string): string {
  if (CRYPTO_ASSET_CLASSES.has(assetClass)) return "now (24/7)";
  return "9:30 PM SGT (Mon–Fri)";
}

// ── Pending orders (in-memory, resets on restart) ────────────────────────────

export interface PendingOrder {
  id:          string;
  symbol:      string;
  side:        "buy" | "sell";
  amountUsd:   number;
  assetClass:  string;
  broker:      string;
  queuedAt:    Date;
}

const pendingOrdersMap = new Map<string, PendingOrder>();

export function getPendingOrders(): PendingOrder[] {
  return Array.from(pendingOrdersMap.values());
}

export function removePendingOrder(id: string): void {
  pendingOrdersMap.delete(id);
}

// ── Conversation session state (multi-turn clarification + confirmation) ──────
type BrokerKey = "bybit" | "okx" | "etoro";

interface CloseIntent {
  symbol:     string;
  amountType: "all" | "pct" | "usd" | "units";
  amount?:    number; // pct 0-100, usd value, or base-asset units
  broker?:    BrokerKey;
}

type PendingStep =
  | { type: "confirm_trade"; trade: ParsedTrade; totalCapital: number }
  | { type: "await_amount";  symbol: string; side: "buy"|"sell"; broker: BrokerKey; assetClass: string; orderType: "market"|"limit"; limitPrice: number|null }
  | { type: "await_broker";  symbol: string; side: "buy"|"sell"; amountUsd: number; assetClass: string; orderType: "market"|"limit"; limitPrice: number|null }
  | { type: "await_close_amount";  symbol: string; broker?: BrokerKey }
  | { type: "await_close_broker";  intent: CloseIntent };

interface SessionState { step: PendingStep; expiresAt: number; }

const sessionStates = new Map<string, SessionState>();
const SESSION_TTL   = 5 * 60 * 1000;

function getSession(id: string): PendingStep | null {
  const s = sessionStates.get(id);
  if (!s || Date.now() > s.expiresAt) { sessionStates.delete(id); return null; }
  return s.step;
}
function setSession(id: string, step: PendingStep): void {
  sessionStates.set(id, { step, expiresAt: Date.now() + SESSION_TTL });
}
function clearSession(id: string): void { sessionStates.delete(id); }

export interface AssistantProfile {
  name:             string;
  riskTolerance:    "low" | "medium" | "high";
  investmentGoal:   string;
  monthlyBudgetUsd?: number;
}

export interface AssistantHolding {
  symbol:           string;
  assetClass:       string;
  currentValueUsd:  number;
  unrealisedPnlPct: number;
}

export interface AssistantContext {
  profile:              AssistantProfile;
  totalPortfolioUsd:    number;
  availableCashUsd:     number;
  holdings:             AssistantHolding[];
  targetAllocations:    Record<string, number>;
  activeStrategy:       string;
  rebalancingStatus:    "on_track" | "needs_rebalance";
  operationMode:        "autonomous" | "approval";
  approvalThresholdUsd: number;
}

export interface AssistantReply {
  message: string;
  _meta?: {
    model:            string;
    taskType:         string;
    estimatedCostUsd: number;
    cachedTokens:     number;
    latencyMs:        number;
  };
}

type Intent =
  | "simple_question" | "trade_request" | "strategy_request"
  | "rebalance_request" | "mode_change" | "risk_question" | "performance_query";

const INTENT_TO_TASK: Record<Intent, TaskType> = {
  simple_question:   "assistant_reply",
  trade_request:     "trade_decision",
  strategy_request:  "strategy_generation",
  rebalance_request: "rebalance_plan",
  mode_change:       "assistant_reply",
  risk_question:     "risk_alert",
  performance_query: "performance_analysis",
};

async function detectIntent(message: string): Promise<Intent> {
  const res = await llm.json<{ intent: Intent }>({
    taskType:      "command_parse",
    systemContext: "You classify trading assistant messages. Reply JSON only.",
    prompt:        `Classify intent: "${message.slice(0, 200)}"`,
    schema: {
      type: "object", required: ["intent"],
      properties: { intent: { type: "string",
        enum: ["simple_question","trade_request","strategy_request",
               "rebalance_request","mode_change","risk_question","performance_query"] } },
    },
    fallback: { intent: "simple_question" as Intent },
  });
  return res.data.intent;
}

interface ParsedTrade {
  symbol:       string;
  side:         "buy" | "sell";
  amountUsd:    number;
  amountMissing?: boolean;
  broker:       "etoro" | "bybit" | "okx" | "mock";
  assetClass:   string;
  orderType:    "market" | "limit";
  limitPrice:   number | null;
}

async function parseTrade(message: string): Promise<ParsedTrade | null> {
  const res = await llm.json<{ symbol: string|null; side: string; amountUsd: number|null; broker: string; assetClass: string; orderType: string; limitPrice: number|null }>({
    taskType:      "command_parse",
    systemContext: [
      "Extract trade parameters. Reply JSON only.",
      "Default broker is OKX for all crypto. Only use 'bybit' if user explicitly says 'on Bybit'. Stocks/ETFs → broker=etoro.",
      "Symbol: crypto with dash 'BTC-USDT' → broker=okx. Bare 'BTC','ETH','SOL' → 'BTC-USDT','ETH-USDT','SOL-USDT' broker=okx. Stocks/ETFs → broker=etoro.",
      "amountUsd: null if not specified by user.",
      "orderType: 'limit' if user says 'at $X','above $X','below $X','limit $X'. Otherwise 'market'.",
      "limitPrice: the price value for limit orders, null for market orders.",
    ].join(" "),
    prompt: `Message: "${message.slice(0, 300)}"\nReturn: {"symbol":"TICKER or null","side":"buy|sell","amountUsd":number or null,"broker":"okx|etoro|bybit","assetClass":"Equity|Crypto|ETF|Commodity","orderType":"market|limit","limitPrice":number or null}`,
    schema: {
      type: "object",
      properties: {
        symbol:     { type: ["string","null"] },
        side:       { type: "string" },
        amountUsd:  { type: ["number","null"] },
        broker:     { type: "string" },
        assetClass: { type: "string" },
        orderType:  { type: "string" },
        limitPrice: { type: ["number","null"] },
      },
    },
    fallback: { symbol: null, side: "buy", amountUsd: null, broker: "okx", assetClass: "Crypto", orderType: "market", limitPrice: null },
  });

  const d = res.data;
  if (!d.symbol || !d.side) return null;

  // Normalise symbol to OKX spot format for crypto unless explicitly Bybit
  let symbol = d.symbol.toUpperCase().replace("/", "-").replace("-SWAP", "");
  const explicitBybit = message.toLowerCase().includes("bybit");
  const broker = explicitBybit ? "bybit" : ((d.broker as ParsedTrade["broker"]) ?? "okx");

  // Bare crypto symbols → OKX dash format
  if (broker === "okx" && !symbol.includes("-") && !["Equity","ETF"].includes(d.assetClass ?? "")) {
    const quote = symbol.endsWith("USDC") ? "USDC" : "USDT";
    const base  = symbol.replace(/USDT$/, "").replace(/USDC$/, "");
    symbol = `${base}-${quote}`;
  }

  const amountUsd     = d.amountUsd && d.amountUsd > 0 ? d.amountUsd : 0;
  const amountMissing = !d.amountUsd || d.amountUsd <= 0;
  return {
    symbol,
    side:         d.side as "buy" | "sell",
    amountUsd,
    amountMissing,
    broker,
    assetClass:   d.assetClass ?? "Crypto",
    orderType:    (d.orderType === "limit" ? "limit" : "market"),
    limitPrice:   d.limitPrice ?? null,
  };
}

interface CloseRequest {
  symbols:    string[];
  amountType: "all" | "pct" | "usd" | "units";
  amount?:    number;
  broker?:    BrokerKey;
}

function preParseUnitsClose(message: string): CloseRequest | null {
  // "sell 0.1 SOL", "sell 0.1 sol on okx", "close 0.5 ETH on bybit"
  const m = message.match(/^(?:sell|close)\s+(\d+(?:\.\d+)?)\s+([A-Za-z]+)(?:\s+on\s+(okx|bybit|etoro))?/i);
  if (!m) return null;
  const amount = parseFloat(m[1]!);
  const sym    = m[2]!.toUpperCase().replace(/USDT$/, "").replace(/USDC$/, "");
  const broker = m[3]?.toLowerCase() as BrokerKey | undefined;
  if (isNaN(amount) || amount <= 0) return null;
  return { symbols: [sym], amountType: "units", amount, broker };
}

async function parseCloseRequest(message: string): Promise<CloseRequest | null> {
  // Fast-path: regex handles "sell/close N SYMBOL [on broker]" without LLM call
  const fast = preParseUnitsClose(message);
  if (fast) return fast;

  const res = await llm.json<{ symbols: string[]|null; amountType: string; amount: number|null; broker: string|null }>({
    taskType:      "command_parse",
    systemContext: [
      "Extract close/exit intent. Reply JSON only.",
      "symbols: array of tickers to close (e.g. ['SOL','BTC']). Normalise: 'SOL/USDT'→'SOL', 'ETH-USDT'→'ETH'.",
      "amountType: 'all' (default), 'pct' for %, 'usd' for dollar amount, 'units' for base-asset quantity.",
      "broker: 'bybit'|'okx'|'etoro' if user says 'on Bybit/OKX/eToro', else null.",
    ].join(" "),
    prompt: `Message: "${message.slice(0, 300)}"\nReturn: {"symbols":["TICKER"],"amountType":"all|pct|usd|units","amount":number or null,"broker":"bybit|okx|etoro or null"}\nExamples: 'close ETH'→{symbols:["ETH"],amountType:"all",broker:null}, 'close 50 SOL on OKX'→{symbols:["SOL"],amountType:"units",amount:50,broker:"okx"}, 'close $50 ETH'→{symbols:["ETH"],amountType:"usd",amount:50}, 'close half ETH'→{symbols:["ETH"],amountType:"pct",amount:50}`,
    schema: {
      type: "object",
      properties: {
        symbols:    { type: "array", items: { type: "string" } },
        amountType: { type: "string" },
        amount:     { type: ["number","null"] },
        broker:     { type: ["string","null"] },
      },
    },
    fallback: { symbols: null, amountType: "all", amount: null, broker: null },
  });

  const d = res.data;
  if (!d.symbols?.length) return null;
  const validBrokers = new Set<string>(["bybit","okx","etoro"]);
  return {
    symbols:    d.symbols.map(s => s.toUpperCase().replace("/","-").replace("-SWAP","").replace("-USDT","").replace("-USDC","")),
    amountType: (d.amountType as "all"|"pct"|"usd"|"units") ?? "all",
    amount:     d.amount ?? undefined,
    broker:     (d.broker && validBrokers.has(d.broker) ? d.broker as BrokerKey : undefined),
  };
}


async function executeClose(intent: CloseIntent): Promise<string> {
  const { symbol, amountType, amount, broker } = intent;

  // ── Bybit close ───────────────────────────────────────────────────────────
  if (broker === "bybit") {
    try {
      let orderId: string;
      if (amountType === "pct" && amount != null) {
        ({ orderId } = await bybitClosePercent(symbol, amount));
        const pctStr = `${amount}%`;
        return [`✅ PARTIAL CLOSE ${symbol} (${pctStr})`, `Order ID: ${orderId}`, `Broker: Bybit Testnet`].join("\n");
      } else if (amountType === "usd" && amount != null) {
        ({ orderId } = await bybitClosePartial(symbol, amount));
        return [`✅ PARTIAL CLOSE ${symbol} (~$${amount})`, `Order ID: ${orderId}`, `Broker: Bybit Testnet`].join("\n");
      } else {
        const closeResult = await bybitClose(symbol);
        const { orderId, entryPrice: ep, size, side } = closeResult;
        const exitTicker = await bybitGetTicker(symbol).catch(() => null);
        const exitPrice  = exitTicker?.lastPrice ?? ep;
        const direction  = side === "Buy" ? "long" : "short";
        const pnl        = direction === "long" ? (exitPrice - ep) * size : (ep - exitPrice) * size;
        const pnlStr     = `${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
        closeOpenTrade({ symbol, broker: "bybit", exitPrice, amountUsd: size * ep, entryPriceOverride: ep }).catch(() => {});
        const mode = (process.env["BYBIT_TRADING_MODE"] ?? "testnet") === "live" ? "Live" : "Testnet";
        return [`✅ CLOSED ${symbol}`, `Order ID: ${orderId}`, `P/L: ${pnlStr}`, `Broker: Bybit ${mode}`].join("\n");
      }
    } catch (err) {
      return `❌ Failed to close ${symbol} on Bybit: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── OKX close ─────────────────────────────────────────────────────────────
  if (broker === "okx") {
    const instId  = symbol.includes("-") ? symbol : `${symbol}-USDT`;
    const okxMode = okxPaperMode ? "Paper" : (process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live");
    const base    = instId.split("-")[0] ?? symbol;

    // Fetch live position (used by all close paths for entry price)
    const allPositions = okxPaperMode
      ? await getPositionsPaper().catch(() => [])
      : await okxGetPositions().catch(() => []);
    const livePos = allPositions.find(p =>
      p.symbol === instId || p.symbol.split("-")[0] === symbol.split("-")[0]
    );

    // Helper: fetch OKX ticker price
    const fetchExitPrice = async (): Promise<number> => {
      try {
        const okxBase = process.env["OKX_BASE_URL"] ?? "https://www.okx.com";
        const tr = await fetch(`${okxBase}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`, { signal: AbortSignal.timeout(4000) });
        const tj = await tr.json() as { code: string; data: Array<{ last: string }> };
        if (tj.code === "0" && tj.data[0]) return parseFloat(tj.data[0].last);
      } catch { /* fall through */ }
      return livePos?.entryPrice ?? 0;
    };

    // Partial close by USD amount
    if (amountType === "usd" && amount != null) {
      try {
        const r         = await okxOpenSpot(instId, "sell", amount);
        const exitPrice = r.entryPrice;  // ticker.last at execution time
        const entryPrice = livePos?.entryPrice ?? 0;
        const units      = entryPrice > 0 ? amount / exitPrice : 0;
        const pnl        = entryPrice > 0 ? (exitPrice - entryPrice) * units : 0;
        const pnlStr     = entryPrice > 0 ? `P/L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : null;
        return [
          `✅ CLOSED ${instId} — Partial`,
          `Sold: ~$${amount} (~${units.toFixed(6)} ${base})`,
          ...(pnlStr ? [pnlStr] : []),
          `Order ID: ${r.orderId}`,
          `Broker: OKX ${okxMode}`,
        ].join("\n");
      } catch (err) {
        return `❌ Failed to close ${instId} on OKX: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    // Partial close by base-asset units
    if (amountType === "units" && amount != null) {
      try {
        const r          = await okxCloseByUnits(instId, amount);
        const exitPrice  = await fetchExitPrice();
        const entryPrice = livePos?.entryPrice ?? 0;
        const pnl        = entryPrice > 0 ? (exitPrice - entryPrice) * amount : 0;
        const pnlStr     = entryPrice > 0 ? `P/L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}` : null;
        return [
          `✅ CLOSED ${instId} — Partial`,
          `Sold: ${amount} ${base}`,
          ...(pnlStr ? [pnlStr] : []),
          `Order ID: ${r.orderId}`,
          `Broker: OKX ${okxMode}`,
        ].join("\n");
      } catch (err) {
        return `❌ Failed to close ${instId} on OKX: ${err instanceof Error ? err.message : String(err)}`;
      }
    }

    try {
      const result = okxPaperMode ? await closePositionPaper(instId) : await okxClose(instId);

      // Fetch exit price from OKX ticker
      let exitPrice = livePos?.entryPrice ?? 0;
      try {
        const okxBase = process.env["OKX_BASE_URL"] ?? "https://www.okx.com";
        const tr  = await fetch(`${okxBase}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`, { signal: AbortSignal.timeout(4000) });
        const tj  = await tr.json() as { code: string; data: Array<{ last: string }> };
        if (tj.code === "0" && tj.data[0]) exitPrice = parseFloat(tj.data[0].last);
      } catch { /* use entry price as fallback */ }

      // Trigger trade reflection
      if (livePos && livePos.entryPrice > 0) {
        const amountUsd = livePos.size * livePos.entryPrice;
        closeOpenTrade({ symbol: instId, broker: "okx", exitPrice, amountUsd, entryPriceOverride: livePos.entryPrice }).catch(() => {});
      }

      const pnlStr = livePos && exitPrice > 0
        ? (() => {
            const pnl = (exitPrice - livePos.entryPrice) * livePos.size;
            return `P/L: ${pnl >= 0 ? "+" : ""}$${pnl.toFixed(2)}`;
          })()
        : null;

      return [
        `✅ CLOSED ${instId} — Executed`,
        `Order ID: ${result.orderId}`,
        ...(result.message ? [`Sold: ${result.message.replace(/^Sold /, "")}`] : []),
        ...(pnlStr ? [pnlStr] : []),
        `Broker: OKX ${okxMode}`,
      ].join("\n");
    } catch (err) {
      return `❌ Failed to close ${instId} on OKX: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // ── eToro close ───────────────────────────────────────────────────────────
  let portfolio: EtoroPortfolio;
  try { portfolio = (await getPortfolio()) as EtoroPortfolio; }
  catch (err) { return `❌ Could not fetch portfolio: ${err instanceof Error ? err.message : String(err)}`; }

  const pos = (portfolio?.positions ?? []).find(p =>
    (p.symbol ?? "").toUpperCase() === symbol || String(p.positionId ?? "") === symbol
  );
  if (!pos) { await db.delete(holdingsTable).where(eq(holdingsTable.symbol, symbol)); return `⚠️ No open position found for ${symbol} on eToro.`; }

  const posId = String(pos.positionId ?? "");
  try { await etoroClose(posId); } catch (err) { return `❌ Failed to close ${symbol}: ${err instanceof Error ? err.message : String(err)}`; }

  const profit  = pos.profit ?? 0;
  const pnlSign = profit >= 0 ? "+" : "";
  closeOpenTrade({
    symbol,
    broker:      "etoro",
    exitPrice:   0,
    amountUsd:   pos.investedAmount ?? 0,
    pnlOverride: profit,
  }).catch(() => {});
  await db.delete(holdingsTable).where(eq(holdingsTable.symbol, symbol));
  return [`✅ CLOSED ${symbol}`, `Position ID: ${posId}`, `P/L: ${pnlSign}$${profit.toFixed(2)}`, `Broker: eToro`].join("\n");
}

async function handleClosePosition(intent: CloseIntent, sessionId?: string): Promise<string> {
  const { symbol } = intent;

  // Explicit broker → skip auto-detect entirely
  if (intent.broker) return executeClose(intent);

  // Auto-detect: check Bybit → OKX → eToro in order
  const bybitSym = symbol.toUpperCase().replace(/-USDT$/, "").replace(/-USDC$/, "") + "USDT";
  const [bybitPositions, okxPositions, etoroPortfolio] = await Promise.all([
    bybitGetPositions().catch(() => []),
    (okxPaperMode ? getPositionsPaper() : okxGetPositions()).catch(() => []),
    getPortfolio().then(p => ((p as EtoroPortfolio)?.positions ?? []) as EtoroPos[]).catch(() => [] as EtoroPos[]),
  ]);

  const bybitPos = bybitPositions.find(p =>
    p.symbol === bybitSym || p.symbol === symbol || p.symbol.replace("USDT", "") === symbol
  );
  const okxPos = okxPositions.find(p => {
    const base = p.symbol.split("-")[0] ?? "";
    return base === symbol || p.symbol === symbol;
  });
  const etoroPos = etoroPortfolio.find(p =>
    (p.symbol ?? "").toUpperCase() === symbol.toUpperCase()
  );

  // Multiple open → ask which
  if (bybitPos && okxPos && sessionId) {
    setSession(sessionId, { type: "await_close_broker", intent });
    const bPnl = `${bybitPos.pnl >= 0 ? "+" : ""}$${bybitPos.pnl.toFixed(2)}`;
    const oPnl = `${okxPos.pnl  >= 0 ? "+" : ""}$${okxPos.pnl.toFixed(2)}`;
    return [
      `Which platform?`,
      `• Bybit — ${bybitPos.symbol} ${bybitPos.side} ×${bybitPos.size} (P/L ${bPnl})`,
      `• OKX — ${okxPos.symbol} ×${okxPos.size} (P/L ${oPnl})`,
      `Reply: Bybit or OKX`,
    ].join("\n");
  }

  const resolvedBroker: BrokerKey = bybitPos ? "bybit" : okxPos ? "okx" : etoroPos ? "etoro" : null as unknown as BrokerKey;

  if (!resolvedBroker) {
    return [
      `❌ No open position found for ${symbol}`,
      `(checked Bybit, OKX, eToro)`,
    ].join("\n");
  }

  // Ask amount for Bybit partial
  if (intent.amountType === "all" && resolvedBroker === "bybit" && sessionId && bybitPos) {
    const usdVal = (bybitPos.size * bybitPos.entryPrice).toFixed(0);
    setSession(sessionId, { type: "await_close_amount", symbol, broker: "bybit" });
    return [
      `Close how much of ${bybitPos.symbol}?`,
      `• Full position (~$${usdVal}) — reply "all"`,
      `• Partial — reply a dollar amount (e.g. "$20") or percentage (e.g. "50%")`,
    ].join("\n");
  }

  return executeClose({ ...intent, broker: resolvedBroker });
}

async function fetchSymbolPrice(symbol: string): Promise<number | null> {
  try {
    // OKX spot/SWAP symbols — any dash-separated pair (BTC-USDT, ETH-USDT, BTC-USDT-SWAP)
    if (symbol.includes("-")) {
      const instId = symbol.toUpperCase().replace("-SWAP", ""); // normalise to spot
      const base   = process.env["OKX_BASE_URL"] ?? "https://www.okx.com";
      const res  = await fetch(
        `${base}/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`,
        { signal: AbortSignal.timeout(4000) }
      );
      const json = await res.json() as { code: string; data: Array<{ last: string }> };
      if (json.code === "0" && json.data[0]) return parseFloat(json.data[0].last);
      return null;
    }
    // Equities/ETFs — Yahoo Finance
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=${encodeURIComponent(symbol)}&range=1d&interval=1d`;
    const res = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    const data = await res.json() as {
      spark?: { result?: Array<{ response?: Array<{ meta?: { regularMarketPrice?: number } }> }> }
    };
    return data?.spark?.result?.[0]?.response?.[0]?.meta?.regularMarketPrice ?? null;
  } catch {
    return null;
  }
}

async function executeLimitOrder(trade: ParsedTrade): Promise<string> {
  const { symbol, side, amountUsd, broker, limitPrice, assetClass } = trade;
  if (!limitPrice) return `❌ Limit price missing.`;

  const isBybit   = broker === "bybit";
  const isOKXSpot = broker === "okx";
  const leverage  = isOKXSpot ? 1 : isBybit ? 10 : 1;
  const exposure  = (amountUsd * leverage).toFixed(0);
  const base      = symbol.includes("-") ? (symbol.split("-")[0] ?? symbol) : symbol;
  const units     = `~${(amountUsd / limitPrice).toFixed(4)} ${assetClass === "Equity" ? "shares" : base}`;

  // Validate limit price direction for Bybit (GTC buy must be ≤ mark; sell must be ≥ mark)
  if (isBybit) {
    try {
      const ticker = await bybitGetTicker(symbol);
      const mark   = ticker.lastPrice;
      if (side === "buy" && limitPrice > mark) {
        return [
          `⚠️ Limit buy price $${limitPrice.toLocaleString("en-US")} is above current mark price $${mark.toLocaleString("en-US", { maximumFractionDigits: 2 })}.`,
          `Bybit rejects GTC buys above market. To buy now use a market order: "buy $${amountUsd} ${base} on Bybit"`,
          `Or set a lower limit: "buy $${amountUsd} ${base} at $${(mark * 0.98).toLocaleString("en-US", { maximumFractionDigits: 0 })} on Bybit"`,
        ].join("\n");
      }
      if (side === "sell" && limitPrice < mark) {
        return [
          `⚠️ Limit sell price $${limitPrice.toLocaleString("en-US")} is below current mark price $${mark.toLocaleString("en-US", { maximumFractionDigits: 2 })}.`,
          `Bybit rejects GTC sells below market. To sell now use a market order: "sell $${amountUsd} ${base} on Bybit"`,
        ].join("\n");
      }
    } catch { /* skip validation if ticker fetch fails */ }
  }

  try {
    let orderId: string;
    let brokerLabel: string;

    if (isBybit) {
      ({ orderId } = await bybitOpenLimit(symbol, side === "buy" ? "Buy" : "Sell", amountUsd, limitPrice, 10));
      brokerLabel = `Bybit ${(process.env["BYBIT_TRADING_MODE"] ?? "testnet") === "live" ? "Live" : "Testnet"}`;
    } else if (isOKXSpot) {
      const r = await okxOpenLimit(symbol, side, amountUsd, limitPrice);
      orderId = r.orderId;
      brokerLabel = `OKX ${process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live"}`;
    } else {
      return `❌ Limit orders not supported for ${broker}`;
    }

    return [
      `⏳ LIMIT ${side.toUpperCase()} ${symbol} — Placed`,
      `Order ID: ${orderId}`,
      `Limit price: $${limitPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}`,
      `Amount: $${amountUsd}${leverage > 1 ? ` at ${leverage}x` : " (spot)"}`,
      ...(leverage > 1 ? [`Exposure: $${exposure}`] : []),
      `Units: ${units}`,
      `Broker: ${brokerLabel}`,
      `Status: Waiting to fill`,
    ].join("\n");
  } catch (err) {
    return `❌ Limit order failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

async function executeTrade(trade: ParsedTrade, totalCapital: number): Promise<string> {
  // Sell on OKX spot = close existing position, not a new short
  if (trade.side === "sell" && trade.broker === "okx") {
    return executeClose({ symbol: trade.symbol, amountType: "usd", amount: trade.amountUsd, broker: "okx" });
  }

  // Route limit orders directly — no approval gate needed
  if (trade.orderType === "limit" && trade.limitPrice) {
    return executeLimitOrder(trade);
  }

  const proposal = buildProposal({
    symbol:     trade.symbol,
    side:       trade.side,
    amountUsd:  trade.amountUsd,
    assetClass: trade.assetClass,
    rationale:  "NL instruction via assistant",
    broker:     trade.broker,
  });

  const result    = await approvalGate.submit(proposal);
  const isOKXSpot = proposal.broker === "okx";
  const isBybit   = proposal.broker === "bybit";
  const capPct    = ((trade.amountUsd / totalCapital) * 100).toFixed(0);
  const leverage  = isOKXSpot ? 1 : isBybit ? 10 : (trade.assetClass === "Crypto" ? 50 : 20);
  const exposure  = (trade.amountUsd * leverage).toFixed(0);
  const orderId   = result.orderId ?? proposal.id;

  if (result.action === "rejected") {
    return [
      `❌ ${trade.side.toUpperCase()} ${trade.symbol} — Rejected`,
      `Reason: ${result.message ?? "Unknown error"}`,
      `Nothing was placed.`,
    ].join("\n");
  }

  // Fetch price once — use Bybit ticker directly for Bybit trades (symbol is bare "BTC" not "BTC-USDT")
  const price = isBybit
    ? await bybitGetTicker(trade.symbol).then(t => t.lastPrice).catch(() => null)
    : await fetchSymbolPrice(trade.symbol);
  const priceStr = price ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "N/A";
  const base     = trade.symbol.includes("-") ? (trade.symbol.split("-")[0] ?? trade.symbol) : trade.symbol;
  const qtyUnit  = trade.assetClass === "Equity" ? "shares" : base;
  // Units = notional exposure / price (contract size for futures, direct qty for spot)
  const notional = trade.amountUsd * leverage;
  const units    = price ? (notional / price) : null;
  const qtyStr   = units ? `~${units.toFixed(4)} ${qtyUnit}` : "N/A";

  if (result.action === "queued") {
    if (trade.amountUsd > totalCapital * 0.5) {
      return [
        `⏳ Awaiting your approval — trade exceeds normal limit`,
        `${trade.side.toUpperCase()} ${trade.symbol}: $${trade.amountUsd.toLocaleString("en-US")}`,
        `Check Telegram for the approval request (expires in 5 min).`,
      ].join("\n");
    }
    return [
      `⏳ ${trade.side.toUpperCase()} ${trade.symbol} — Awaiting approval`,
      `Approval ID: ${proposal.id}`,
      `Amount: $${trade.amountUsd} at ${leverage}x / Exposure: $${exposure} / Units: ${qtyStr}`,
    ].join("\n");
  }

  if (result.action === "executed") {
    // OKX spot is 24/7 — only check market hours for eToro equities
    const marketClosed = !isOKXSpot && !isMarketOpen(trade.assetClass);

    if (marketClosed) {
      pendingOrdersMap.set(orderId, {
        id:         orderId,
        symbol:     trade.symbol,
        side:       trade.side,
        amountUsd:  trade.amountUsd,
        assetClass: trade.assetClass,
        broker:     proposal.broker,
        queuedAt:   new Date(),
      });
      return [
        `⏳ ${trade.side.toUpperCase()} ${trade.symbol} — Pending`,
        `Order ID: ${orderId}`,
        `Amount: $${trade.amountUsd} at ${leverage}x / Exposure: $${exposure} / Units: ${qtyStr}`,
        `Reason: Market closed or liquidity pause`,
        `US market opens: ${nextOpenStr(trade.assetClass)}`,
        `Use /orders to track this`,
      ].join("\n");
    }

    // Filled immediately
    await syncHoldingsFromEtoro().catch(() => {});

    // Log open trade for /history and reflection
    if (isOKXSpot || isBybit) {
      logOpenTrade({
        symbol:     trade.symbol,
        broker:     isOKXSpot ? "okx" : "bybit",
        direction:  trade.side === "buy" ? "long" : "short",
        entryPrice: price ?? 0,
        leverage:   isBybit ? 10 : 1,
        amountUsd:  trade.amountUsd,
        reasoning:  "NL trade instruction",
      }).catch(() => {});
    }

    if (isOKXSpot) {
      const okxMode = okxPaperMode ? "Paper" : (process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live");
      return [
        `✅ ${trade.side.toUpperCase()} ${trade.symbol} — Executed`,
        `Order ID: ${orderId}`,
        `Amount: $${trade.amountUsd} (spot)`,
        `Units: ${qtyStr}`,
        `Broker: OKX ${okxMode}`,
        `Price: ${priceStr}`,
        `Time: ${new Date().toUTCString()}`,
      ].join("\n");
    }

    const brokerLabel = isBybit
      ? `Bybit ${(process.env["BYBIT_TRADING_MODE"] ?? "testnet") === "live" ? "Live" : "Testnet"}`
      : "eToro";
    return [
      `✅ ${trade.side.toUpperCase()} ${trade.symbol} — Executed`,
      `Order ID: ${orderId}`,
      `Amount: $${trade.amountUsd} at ${leverage}x`,
      `Exposure: $${exposure}`,
      `Units: ${qtyStr}`,
      `Broker: ${brokerLabel}`,
      `Time: ${new Date().toUTCString()}`,
    ].join("\n");
  }

  return [
    `❌ ${trade.side.toUpperCase()} ${trade.symbol} — Rejected`,
    `Reason: ${result.message ?? "Unknown error"}`,
    `Nothing was placed.`,
  ].join("\n");
}

async function fetchLivePrices(): Promise<string> {
  const parts: string[] = [];

  // Crypto: Bybit real-time tickers (direct from our trading exchange)
  await Promise.allSettled(["BTCUSDT", "ETHUSDT", "SOLUSDT"].map(async sym => {
    const t    = await bybitGetTicker(sym);
    const sign = t.change24h >= 0 ? "+" : "";
    parts.push(`${sym.replace("USDT","")} $${t.lastPrice.toLocaleString("en-US",{maximumFractionDigits:2})} (${sign}${t.change24h.toFixed(1)}%)`);
  }));

  // Equities: Yahoo Finance (no direct broker API for eToro stocks)
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/spark?symbols=AAPL,NVDA,MSFT&range=1d&interval=1d`;
    const res  = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (res.ok) {
      const data = await res.json() as {
        spark?: { result?: Array<{ symbol: string; response?: Array<{ meta?: { regularMarketPrice?: number; chartPreviousClose?: number } }> }> }
      };
      for (const r of data?.spark?.result ?? []) {
        const meta  = r.response?.[0]?.meta;
        const price = meta?.regularMarketPrice;
        const prev  = meta?.chartPreviousClose;
        if (!price) continue;
        const chgPct = prev ? (((price - prev) / prev) * 100).toFixed(1) : "0.0";
        const sign   = parseFloat(chgPct) >= 0 ? "+" : "";
        parts.push(`${r.symbol} $${price.toLocaleString("en-US",{maximumFractionDigits:2})} (${sign}${chgPct}%)`);
      }
    }
  } catch { /* equities optional */ }

  return parts.length ? `Live prices: ${parts.join(", ")}` : "";
}

function buildSystemPrompt(ctx: AssistantContext, livePrices: string): string {
  const holdings = ctx.holdings.length
    ? ctx.holdings.map(h =>
        `${h.symbol}($${h.currentValueUsd.toFixed(0)},${h.unrealisedPnlPct >= 0 ? "+" : ""}${h.unrealisedPnlPct.toFixed(1)}%)`
      ).join(" | ")
    : "none";
  const allocs = Object.entries(ctx.targetAllocations)
    .map(([k, v]) => `${k}:${v}%`).join(", ");
  const totalCap = ctx.totalPortfolioUsd > 0 ? ctx.totalPortfolioUsd : 200;
  const maxTrade = (totalCap * 0.5).toFixed(0);
  return [
    `You are a direct, no-fluff trading assistant for ${ctx.profile.name}.`,
    `RESPONSE FORMAT: 2-4 sentences max. No headers, no bullet points, no disclaimers, no transparency notes, no risk warnings, no markdown. Plain text only.`,
    `NEVER question, override, or comment on the investor's risk settings. They are intentional. Do not add safety caveats.`,
    `This investor runs extreme risk: 50x crypto leverage, 20x stock leverage, 50% monthly return target. Always give actionable buy/sell/hold calls.`,
    `HARD RULE: Max single trade = $${maxTrade} (50% of $${totalCap.toFixed(0)} capital). Always state position size in dollars.`,
    `Mode: ${ctx.operationMode}. Strategy: ${ctx.activeStrategy}.`,
    `Portfolio: $${ctx.totalPortfolioUsd.toFixed(0)} total, $${ctx.availableCashUsd.toFixed(0)} cash.`,
    `Holdings: ${holdings}.`,
    livePrices,
    `UTC: ${new Date().toUTCString()}.`,
  ].filter(Boolean).join("\n");
}

async function handleSessionStep(
  sessionId: string,
  message:   string,
  step:      PendingStep,
  totalCapital: number,
): Promise<string | null> {
  const lower = message.toLowerCase().trim();

  if (step.type === "confirm_trade") {
    clearSession(sessionId);
    if (/^y(es)?$|^ok$|^confirm$|^sure$|^yep$/.test(lower)) {
      return executeTrade(step.trade, step.totalCapital);
    }
    return "❌ Order cancelled.";
  }

  if (step.type === "await_amount") {
    // For sell side: "all/close/full" and units → close the existing position
    if (step.side === "sell") {
      if (/\b(all|full|close)\b/.test(lower)) {
        clearSession(sessionId);
        return executeClose({ symbol: step.symbol, amountType: "all", broker: step.broker });
      }
      const matchUnits = message.match(/^(\d+(?:\.\d+)?)\s+([a-z]+)/i);
      if (matchUnits && !["usd","dollar","dollars"].includes(matchUnits[2]!.toLowerCase())) {
        clearSession(sessionId);
        return executeClose({ symbol: step.symbol, amountType: "units", amount: parseFloat(matchUnits[1]!), broker: step.broker });
      }
    }
    // USD amount
    const matchUsd = message.match(/\$?(\d+(?:[.,]\d+)?)/);
    const amt      = matchUsd ? parseFloat(matchUsd[1]!.replace(",", "")) : 0;
    if (!amt || amt < 5) return `Please specify a valid amount (minimum $5). E.g. "$50".\nOr reply "all" to close the full position.`;
    clearSession(sessionId);
    // Sell side → partial close, not a new trade
    if (step.side === "sell") {
      return executeClose({ symbol: step.symbol, amountType: "usd", amount: amt, broker: step.broker });
    }
    const trade: ParsedTrade = {
      symbol: step.symbol, side: step.side, amountUsd: amt,
      broker: step.broker, assetClass: step.assetClass,
      orderType: step.orderType, limitPrice: step.limitPrice,
    };
    return executeTrade(trade, totalCapital);
  }

  if (step.type === "await_broker") {
    const broker = lower.includes("bybit") ? "bybit" : lower.includes("okx") ? "okx" : lower.includes("etoro") ? "etoro" : null;
    if (!broker) return `Please reply with "Bybit", "OKX", or "eToro"`;
    clearSession(sessionId);
    const trade: ParsedTrade = {
      symbol: step.symbol, side: step.side, amountUsd: step.amountUsd,
      broker: broker as BrokerKey, assetClass: step.assetClass,
      orderType: step.orderType, limitPrice: step.limitPrice,
    };
    return executeTrade(trade, totalCapital);
  }

  if (step.type === "await_close_amount") {
    // All / full close — also catches "close sol on okx" style re-statements
    if (/\b(all|full|close)\b/.test(lower)) {
      clearSession(sessionId);
      return executeClose({ symbol: step.symbol, amountType: "all", broker: step.broker });
    }
    // Percentage: "50%", "50 percent"
    const matchPct = message.match(/(\d+(?:\.\d+)?)\s*(?:%|percent)/i);
    if (matchPct) {
      clearSession(sessionId);
      return executeClose({ symbol: step.symbol, amountType: "pct", amount: parseFloat(matchPct[1]!), broker: step.broker });
    }
    // Units: "50 SOL", "50 eth", "50 units" — number followed by a word
    const matchUnits = message.match(/^(\d+(?:\.\d+)?)\s+([a-z]+)/i);
    if (matchUnits) {
      const unitWord = matchUnits[2]!.toLowerCase();
      if (!["usd", "dollar", "dollars"].includes(unitWord)) {
        clearSession(sessionId);
        return executeClose({ symbol: step.symbol, amountType: "units", amount: parseFloat(matchUnits[1]!), broker: step.broker });
      }
    }
    // USD: "$50", "50 usd", "50 dollars", or bare number
    const matchUsd = message.match(/\$(\d+(?:[.,]\d+)?)|(\d+(?:[.,]\d+)?)\s*(?:usd|dollars?)|^(\d+(?:[.,]\d+)?)$/i);
    if (matchUsd) {
      const raw = (matchUsd[1] ?? matchUsd[2] ?? matchUsd[3])!.replace(",", "");
      const val = parseFloat(raw);
      if (val < 5) return `Minimum $5. Please reply with an amount, e.g. "$50".`;
      clearSession(sessionId);
      return executeClose({ symbol: step.symbol, amountType: "usd", amount: val, broker: step.broker });
    }
    return `How much?\n• "all" — close the full position\n• "$50" — sell $50 worth\n• "50 ${step.symbol}" — sell 50 units`;
  }

  if (step.type === "await_close_broker") {
    const broker = lower.includes("bybit") ? "bybit" : lower.includes("okx") ? "okx" : lower.includes("etoro") ? "etoro" : null;
    if (!broker) return `Please reply with "Bybit", "OKX", or "eToro"`;
    clearSession(sessionId);
    return executeClose({ ...step.intent, broker: broker as BrokerKey });
  }

  return null;
}

export async function generateAssistantReply(
  message:    string,
  ctx:        AssistantContext,
  history?:   Array<{ role: "user" | "assistant"; content: string }>,
  sessionId?: string,
): Promise<AssistantReply> {

  const [profileRow] = await db.select({ totalCapital: profileTable.totalCapital }).from(profileTable).limit(1);
  const totalCapital = profileRow?.totalCapital ?? 200;
  if (totalCapital > 10000) console.warn(`[aiResponder] ⚠️ totalCapital seems wrong: $${totalCapital} — check DB`);

  // ── Resume pending session step (confirmation / clarification) ────────────
  if (sessionId) {
    const step = getSession(sessionId);
    if (step) {
      const result = await handleSessionStep(sessionId, message, step, totalCapital);
      if (result !== null) return { message: result };
    }
  }

  const [intent, livePrices] = await Promise.all([detectIntent(message), fetchLivePrices()]);

  if (intent === "trade_request") {
    const closeLower = message.toLowerCase();
    const isClose = /\b(close|exit|sell out|liquidate)\b/.test(closeLower) && !/\bshort\b/.test(closeLower);

    if (isClose) {
      const req = await parseCloseRequest(message);
      if (req && req.symbols.length > 0) {
        if (req.symbols.length === 1) {
          const intent: CloseIntent = { symbol: req.symbols[0]!, amountType: req.amountType, amount: req.amount, broker: req.broker };
          return { message: await handleClosePosition(intent, sessionId) };
        }
        // Multi-symbol: close each sequentially, report combined result
        const mode = req.broker === "okx"
          ? `OKX ${process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live"}`
          : req.broker === "bybit" ? "Bybit" : "all brokers";
        const lines: string[] = [];
        for (const sym of req.symbols) {
          const intent: CloseIntent = { symbol: sym, amountType: req.amountType, amount: req.amount, broker: req.broker };
          const result = await executeClose(intent);
          // Extract short summary from result (first line after ✅/❌)
          lines.push(result.split("\n")[0] ?? result);
        }
        return { message: [`✅ Closed ${req.symbols.length} positions on ${mode}`, ...lines].join("\n") };
      }
    }

    const trade = await parseTrade(message);

    if (trade) {
      // ── FIX 1: Missing amount ────────────────────────────────────────────
      if (trade.amountMissing) {
        if (sessionId) {
          setSession(sessionId, {
            type: "await_amount", symbol: trade.symbol, side: trade.side,
            broker: trade.broker, assetClass: trade.assetClass,
            orderType: trade.orderType, limitPrice: trade.limitPrice,
          });
        }
        return { message: `How much do you want to ${trade.side} ${trade.symbol}? (e.g. "$50" or "$100")` };
      }

      // ── FIX 4: Confirmation gate for orders over $50 ─────────────────────
      if (trade.amountUsd > 50 && sessionId) {
        const isBybit   = trade.broker === "bybit";
        const isOKX     = trade.broker === "okx";
        const leverage  = isOKX ? 1 : isBybit ? 10 : 1;
        const exposure  = trade.amountUsd * leverage;
        const brokerLabel = isBybit
          ? `Bybit ${(process.env["BYBIT_TRADING_MODE"] ?? "testnet") === "live" ? "Live" : "Testnet"}`
          : isOKX ? `OKX ${process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live"}` : "eToro";

        setSession(sessionId, { type: "confirm_trade", trade, totalCapital });
        return {
          message: [
            `About to place:`,
            `${trade.side.toUpperCase()} ${trade.symbol}`,
            `Amount: $${trade.amountUsd}${leverage > 1 ? ` at ${leverage}x → $${exposure.toFixed(0)} exposure` : " (spot)"}`,
            `Type: ${trade.orderType === "limit" ? `Limit @ $${trade.limitPrice?.toLocaleString("en-US") ?? "?"}` : "Market"}`,
            `Broker: ${brokerLabel}`,
            ``,
            `Confirm? (yes/no)`,
          ].join("\n"),
        };
      }

      const statusMsg = await executeTrade(trade, totalCapital);
      return { message: statusMsg };
    }
  }

  const taskType      = INTENT_TO_TASK[intent];
  const systemContext = buildSystemPrompt(ctx, livePrices);
  const res = await llm.chat({ taskType, userMessage: message, systemContext, history });
  return {
    message: res.text,
    _meta: {
      model:            res.model,
      taskType:         res.taskType,
      estimatedCostUsd: res.estimatedCostUsd,
      cachedTokens:     res.cachedTokens,
      latencyMs:        res.latencyMs,
    },
  };
}

export async function getCachedContext(
  fetcher: () => Promise<AssistantContext>
): Promise<AssistantContext> {
  return cache.get(CacheKey.portfolio(), TTL.PORTFOLIO, fetcher);
}
