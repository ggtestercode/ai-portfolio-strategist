/**
 * approvalGate.ts — Trade execution gate
 * Sprint 1: Mock executors. Sprint 2: Real eToro + Bybit.
 */

import { randomUUID }             from "crypto";
import { llm }                    from "./llmRouter";
import { cache, TTL, CacheKey }   from "./contextCache";
import { db }                     from "@workspace/db";
import { tradeProposals,
         operationConfig,
         profileTable,
         transactionsTable }      from "@workspace/db/schema";
import { eq }                     from "drizzle-orm";

export type OperationMode = "autonomous" | "approval";

export interface TradeProposal {
  id:              string;
  symbol:          string;
  side:            "buy" | "sell";
  amountUsd:       number;
  assetClass:      string;
  broker:          "etoro" | "bybit" | "okx" | "mock";
  rationale:       string;
  score?:          number;
  currentPrice?:   number;
  dataTimestamp?:  string;
  proposedAt:      string;
  stopLossPrice?:  number;
  takeProfitPrice?: number;
  tp1Price?:           number;
  limitPrice?:         number;
  tp1ClosePercent?:    number;
  tp2ClosePercent?:    number;
}

export interface PendingApproval {
  proposal:  TradeProposal;
  summary:   string;
  expiresAt: string;
  status:    "pending";
  capitalLimitWarning?: {
    capLimit:         number;
    multiple:         number;
    autoModeOverride: boolean;
  };
}

export interface GateResult {
  action:    "queued" | "executed" | "rejected" | "failed";
  proposal:  TradeProposal;
  message:   string;
  orderId?:  string;
  error?:    string;
}

export type BrokerExecutor = (p: TradeProposal) => Promise<{ orderId?: string }>;

const mockExecutor: BrokerExecutor = async (p) => {
  console.log(`[MOCK] ${p.side.toUpperCase()} ${p.symbol} $${p.amountUsd} via ${p.broker}`);
  return { orderId: `MOCK-${Date.now()}` };
};

const pendingMap  = new Map<string, PendingApproval>();
const EXPIRY_MS   = 15 * 60 * 1000;
const CRYPTO_SYMS = new Set(["BTC","ETH","SOL","BNB","AVAX","ARB","OP","MATIC","LINK","DOT","ATOM","INJ","TIA","SUI","SEI"]);

class ApprovalGate {
  private executors: Record<"etoro"|"bybit"|"okx"|"mock", BrokerExecutor> = {
    etoro: mockExecutor,
    bybit: mockExecutor,
    okx:   mockExecutor,
    mock:  mockExecutor,
  };
  private notifyFn: ((a: PendingApproval) => Promise<void>) | null = null;

  async getConfig(): Promise<{ mode: OperationMode; thresholdUsd: number }> {
    return cache.get(CacheKey.operationConfig(), TTL.OPERATION_CONFIG, async () => {
      const row = await db.query.operationConfig.findFirst();
      return {
        mode:         (row?.mode ?? "approval") as OperationMode,
        thresholdUsd: parseFloat(row?.approvalThresholdUsd ?? "500"),
      };
    });
  }

  async setMode(mode: OperationMode): Promise<void> {
    await db.update(operationConfig)
      .set({ mode, updatedAt: new Date() })
      .where(eq(operationConfig.id, "singleton"));
    cache.invalidate(CacheKey.operationConfig());
  }

  async setThreshold(usd: number): Promise<void> {
    await db.update(operationConfig)
      .set({ approvalThresholdUsd: String(usd), updatedAt: new Date() })
      .where(eq(operationConfig.id, "singleton"));
    cache.invalidate(CacheKey.operationConfig());
  }

  registerExecutor(broker: "etoro" | "bybit" | "okx", fn: BrokerExecutor): void {
    this.executors[broker] = fn;
    console.log(`[ApprovalGate] Registered executor: ${broker}`);
  }

  registerNotifier(fn: (a: PendingApproval) => Promise<void>): void {
    this.notifyFn = fn;
  }

  async submit(proposal: TradeProposal): Promise<GateResult> {
    const [{ mode, thresholdUsd }, profileRow] = await Promise.all([
      this.getConfig(),
      db.select({ totalCapital: profileTable.totalCapital }).from(profileTable).limit(1).then(r => r[0]),
    ]);
    const totalCapital = profileRow?.totalCapital ?? 200;
    const capLimit     = totalCapital * 0.50;
    const CAP_TTL      = 15 * 60 * 1000;

    if (proposal.amountUsd > capLimit) {
      // Queue for manual approval with capital-limit warning instead of auto-rejecting
      const multiple     = proposal.amountUsd / capLimit;
      const autoOverride = mode === "autonomous";
      const expiresAt    = new Date(Date.now() + CAP_TTL).toISOString();

      await db.insert(tradeProposals).values({
        id: proposal.id, symbol: proposal.symbol, side: proposal.side,
        amountUsd: String(proposal.amountUsd), assetClass: proposal.assetClass,
        broker: proposal.broker, rationale: proposal.rationale,
        score:        proposal.score        != null ? String(proposal.score)        : null,
        currentPrice: proposal.currentPrice != null ? String(proposal.currentPrice) : null,
        dataTimestamp: proposal.dataTimestamp ?? null,
        status: "pending",
        expiresAt: new Date(Date.now() + CAP_TTL),
      }).onConflictDoNothing();

      const approval: PendingApproval = {
        proposal,
        summary: "",
        expiresAt,
        status: "pending",
        capitalLimitWarning: { capLimit, multiple, autoModeOverride: autoOverride },
      };
      pendingMap.set(proposal.id, approval);

      if (this.notifyFn) {
        await this.notifyFn(approval).catch(e => console.error("[Gate] Capital limit notify failed:", e));
      }

      console.log(`[ApprovalGate] Capital-limit approval queued ${proposal.id}: $${proposal.amountUsd} vs $${capLimit} limit (${multiple.toFixed(1)}x)`);
      return { action: "queued", proposal, message: `Capital limit approval required (${multiple.toFixed(1)}x limit)` };
    }

    await db.insert(tradeProposals).values({
      id: proposal.id, symbol: proposal.symbol, side: proposal.side,
      amountUsd: String(proposal.amountUsd), assetClass: proposal.assetClass,
      broker: proposal.broker, rationale: proposal.rationale,
      score:        proposal.score        != null ? String(proposal.score)        : null,
      currentPrice: proposal.currentPrice != null ? String(proposal.currentPrice) : null,
      dataTimestamp: proposal.dataTimestamp ?? null,
      status: "pending",
      expiresAt: new Date(Date.now() + EXPIRY_MS),
      stopLossPrice:   proposal.stopLossPrice   ?? null,
      takeProfitPrice: proposal.takeProfitPrice ?? null,
      tp1Price:        proposal.tp1Price        ?? null,
    }).onConflictDoNothing();

    const needsApproval = mode === "approval" || proposal.amountUsd >= thresholdUsd;
    return needsApproval ? this.queue(proposal) : this.execute(proposal);
  }

  async approve(proposalId: string): Promise<GateResult> {
    const pending = pendingMap.get(proposalId);
    if (!pending) {
      const row = await db.query.tradeProposals.findFirst({
        where: eq(tradeProposals.id, proposalId),
      });
      if (!row || row.status !== "pending") {
        return { action:"failed", proposal:{id:proposalId} as TradeProposal,
                 message:"Trade not found or already processed." };
      }
      if (row.expiresAt && new Date(row.expiresAt) < new Date()) {
        await db.update(tradeProposals).set({ status:"expired", resolvedAt:new Date() })
          .where(eq(tradeProposals.id, proposalId));
        return { action:"failed", proposal:{id:proposalId} as TradeProposal,
                 message:"Approval expired — re-analyse before retrying." };
      }
      const proposal: TradeProposal = {
        id:row.id, symbol:row.symbol, side:row.side as "buy"|"sell",
        amountUsd:parseFloat(row.amountUsd), assetClass:row.assetClass,
        broker:row.broker as "etoro"|"bybit"|"mock", rationale:row.rationale,
        proposedAt:row.proposedAt.toISOString(),
        stopLossPrice:   row.stopLossPrice   ?? undefined,
        takeProfitPrice: row.takeProfitPrice ?? undefined,
        tp1Price:        row.tp1Price        ?? undefined,
      };
      return this.execute(proposal);
    }
    if (new Date(pending.expiresAt) < new Date()) {
      pendingMap.delete(proposalId);
      await db.update(tradeProposals).set({ status:"expired", resolvedAt:new Date() })
        .where(eq(tradeProposals.id, proposalId));
      return { action:"failed", proposal:pending.proposal, message:"Approval expired." };
    }
    pendingMap.delete(proposalId);
    return this.execute(pending.proposal);
  }

  async reject(proposalId: string): Promise<GateResult> {
    const pending = pendingMap.get(proposalId);
    pendingMap.delete(proposalId);
    await db.update(tradeProposals).set({ status:"rejected", resolvedAt:new Date() })
      .where(eq(tradeProposals.id, proposalId));
    const proposal = pending?.proposal ?? { id:proposalId } as TradeProposal;
    return { action:"rejected", proposal, message:`Rejected: ${proposal.side?.toUpperCase() ?? ""} ${proposal.symbol ?? proposalId}` };
  }

  getPending(): PendingApproval[] {
    const now = new Date();
    for (const [id,p] of pendingMap.entries()) {
      if (new Date(p.expiresAt) < now) pendingMap.delete(id);
    }
    return [...pendingMap.values()];
  }

  private async queue(proposal: TradeProposal): Promise<GateResult> {
    const summaryRes = await llm.chat({
      taskType:      "approval_summary",
      systemContext: "Write a 2-line trade approval summary. Include asset, direction, amount, reason.",
      userMessage:   `Summarise: ${proposal.side.toUpperCase()} ${proposal.symbol} $${proposal.amountUsd}. Reason: ${proposal.rationale}`,
    });
    const approval: PendingApproval = {
      proposal, summary: summaryRes.text,
      expiresAt: new Date(Date.now() + EXPIRY_MS).toISOString(),
      status: "pending",
    };
    pendingMap.set(proposal.id, approval);
    await db.update(tradeProposals).set({ approvalSummary: summaryRes.text })
      .where(eq(tradeProposals.id, proposal.id));
    if (this.notifyFn) {
      await this.notifyFn(approval).catch(e => console.error("[Gate] Notify failed:", e));
    } else {
      console.log(`[ApprovalGate] PENDING (${proposal.id}):\n${summaryRes.text}`);
    }
    return { action:"queued", proposal,
             message:`Queued for approval (ID: ${proposal.id}). Expires: ${approval.expiresAt}` };
  }

  private async execute(proposal: TradeProposal): Promise<GateResult> {
    const executor = this.executors[proposal.broker] ?? this.executors.mock;
    try {
      const result = await executor(proposal);
      await db.update(tradeProposals)
        .set({ status:"executed", resolvedAt:new Date(), orderId:result.orderId ?? null })
        .where(eq(tradeProposals.id, proposal.id));
      cache.invalidate(CacheKey.portfolio());

      // Log to transactions table for dashboard history
      await db.insert(transactionsTable).values({
        type:       proposal.side === "buy" ? "Buy" : "Sell",
        asset:      proposal.symbol,
        amount:     proposal.side === "buy" ? proposal.amountUsd : -proposal.amountUsd,
        value:      proposal.amountUsd,
        status:     "Completed",
        note:       `${proposal.broker} · ${result.orderId ?? proposal.id}`,
        occurredAt: new Date(),
      }).catch(() => {});

      return { action:"executed", proposal, orderId:result.orderId,
               message:`Executed: ${proposal.side.toUpperCase()} ${proposal.symbol} $${proposal.amountUsd} [${proposal.broker}]` };
    } catch (err: any) {
      await db.update(tradeProposals)
        .set({ status:"failed", resolvedAt:new Date(), executionError:err.message })
        .where(eq(tradeProposals.id, proposal.id));
      return { action:"failed", proposal, message:`Execution failed: ${err.message}`, error:err.message };
    }
  }
}

export const approvalGate = new ApprovalGate();

const EQUITY_CLASSES = new Set(["Equity", "equity", "US Equity", "us equity", "Stock", "stock", "ETF", "etf"]);

export function buildProposal(
  p: Omit<TradeProposal, "id"|"broker"|"proposedAt"> & { broker?: TradeProposal["broker"] }
): TradeProposal {
  const isOKXSymbol   = p.symbol.includes("-");
  const isCryptoClass = p.assetClass === "Crypto" || p.assetClass === "crypto";
  const isEquityClass = EQUITY_CLASSES.has(p.assetClass);
  const isCryptoSym   = CRYPTO_SYMS.has(p.symbol.toUpperCase().replace(/USDT$|USDC$/, ""));
  const defaultBroker = isEquityClass
    ? "etoro"
    : (isCryptoClass || isCryptoSym || isOKXSymbol)
      ? "okx"
      : "etoro";
  return {
    ...p,
    id:         randomUUID(),
    broker:     p.broker ?? defaultBroker,
    proposedAt: new Date().toISOString(),
  };
}
