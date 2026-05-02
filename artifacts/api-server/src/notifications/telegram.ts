import TelegramBot from "node-telegram-bot-api";
import { approvalGate, type PendingApproval } from "../lib/approvalGate";
import {
  generateAssistantReply,
  getCachedContext,
  type AssistantContext,
} from "../lib/aiResponder";
import { getPortfolioSnapshot } from "../lib/portfolio";
import {
  db,
  profileTable,
  holdingsTable,
  targetAllocationsTable,
} from "@workspace/db";

let _bot: TelegramBot | null = null;

function getBot(): TelegramBot {
  if (_bot) return _bot;
  const token = process.env["TELEGRAM_BOT_TOKEN"];
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN env var is required");
  _bot = new TelegramBot(token, { polling: false });
  return _bot;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function utcNow(): string {
  return new Date().toUTCString();
}

async function buildContext(): Promise<AssistantContext> {
  return getCachedContext(async () => {
    const [profile, holdings, allocations, config] = await Promise.all([
      db.select().from(profileTable).limit(1).then(r => r[0]),
      db.select().from(holdingsTable),
      db.select().from(targetAllocationsTable),
      approvalGate.getConfig(),
    ]);
    return {
      profile: {
        name:           profile?.name          ?? "Investor",
        riskTolerance:  (profile?.riskTolerance ?? "medium") as "low" | "medium" | "high",
        investmentGoal: `Target return: ${profile?.targetReturnPct ?? 10}% over ${profile?.timeHorizonMonths ?? 12} months`,
      },
      totalPortfolioUsd:    holdings.reduce((s, h) => s + h.quantity * h.price, 0),
      availableCashUsd:     0,
      holdings:             holdings.map(h => ({
        symbol:           h.symbol,
        assetClass:       h.assetClass,
        currentValueUsd:  h.quantity * h.price,
        unrealisedPnlPct: h.change24hPct ?? 0,
      })),
      targetAllocations:    Object.fromEntries(allocations.map(a => [a.assetClass, a.targetPct])),
      activeStrategy:       profile?.strategyType ?? "Balanced Growth",
      rebalancingStatus:    "on_track" as const,
      operationMode:        config.mode,
      approvalThresholdUsd: config.thresholdUsd,
    };
  });
}

async function send(text: string, opts?: TelegramBot.SendMessageOptions): Promise<void> {
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID env var is required");
  await getBot().sendMessage(chatId, text, opts);
}

export const sendApprovalRequest = async (approval: PendingApproval): Promise<void> => {
  const { proposal, summary, expiresAt } = approval;
  const text = [
    `🔔 <b>Trade Approval Required</b>`,
    `<b>${proposal.side.toUpperCase()} ${escapeHtml(proposal.symbol)}</b> — $${proposal.amountUsd}`,
    `Broker: ${proposal.broker} | Asset: ${escapeHtml(proposal.assetClass)}`,
    ``,
    escapeHtml(summary),
    ``,
    `ID: <code>${proposal.id}</code>`,
    `Expires: ${new Date(expiresAt).toUTCString()}`,
    `<i>${utcNow()}</i>`,
  ].join("\n");

  await send(text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: "✅ Approve", callback_data: `approve:${proposal.id}` },
        { text: "❌ Reject",  callback_data: `reject:${proposal.id}`  },
      ]],
    },
  });
};

export function startPolling(): void {
  const b = getBot();

  // Inline button callbacks — approve / reject
  b.on("callback_query", async (query) => {
    const data   = query.data ?? "";
    const chatId = query.message?.chat.id;
    const msgId  = query.message?.message_id;

    await b.answerCallbackQuery(query.id).catch(() => {});
    if (!chatId || msgId == null) return;

    const sep        = data.indexOf(":");
    const action     = sep === -1 ? data : data.slice(0, sep);
    const proposalId = sep === -1 ? ""   : data.slice(sep + 1);

    if (action !== "approve" && action !== "reject") return;

    try {
      const result = action === "approve"
        ? await approvalGate.approve(proposalId)
        : await approvalGate.reject(proposalId);

      const icon = action === "approve" ? "✅" : "❌";
      await b.editMessageText(
        `${icon} ${escapeHtml(result.message)}\n<i>${utcNow()}</i>`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML" },
      ).catch(() => {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      await b.editMessageText(
        `⚠️ ${escapeHtml(msg)}\n<i>${utcNow()}</i>`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML" },
      ).catch(() => {});
    }
  });

  // /status — portfolio snapshot
  b.onText(/^\/status(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const [snap, config] = await Promise.all([
        getPortfolioSnapshot(0),
        approvalGate.getConfig(),
      ]);
      const byClass = Object.entries(snap.byAssetClass)
        .map(([k, v]) => `• ${escapeHtml(k)}: $${v.toFixed(2)}`)
        .join("\n");
      await b.sendMessage(chatId, [
        `📊 <b>Portfolio Status</b>`,
        `<i>${utcNow()}</i>`,
        ``,
        `Total: <b>$${snap.totalValue.toFixed(2)}</b>`,
        `24h: ${snap.change24h >= 0 ? "+" : ""}$${snap.change24h.toFixed(2)} (${snap.change24hPct >= 0 ? "+" : ""}${snap.change24hPct.toFixed(2)}%)`,
        `P&amp;L: ${snap.totalProfitLoss >= 0 ? "+" : ""}$${snap.totalProfitLoss.toFixed(2)} (${snap.totalProfitLossPct >= 0 ? "+" : ""}${snap.totalProfitLossPct.toFixed(2)}%)`,
        ``,
        `By asset class:`,
        byClass || `• (empty)`,
        ``,
        `Mode: <b>${config.mode}</b> | Threshold: $${config.thresholdUsd}`,
      ].join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // /pending — list queued trades
  b.onText(/^\/pending(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const pending = approvalGate.getPending();
      if (!pending.length) {
        await b.sendMessage(chatId,
          `✅ No pending approvals.\n<i>${utcNow()}</i>`,
          { parse_mode: "HTML" });
        return;
      }
      const lines = pending.map((p, i) => [
        `${i + 1}. <b>${p.proposal.side.toUpperCase()} ${escapeHtml(p.proposal.symbol)}</b>` +
          ` $${p.proposal.amountUsd} [${p.proposal.broker}]`,
        `   ID: <code>${p.proposal.id}</code>`,
        `   Expires: ${new Date(p.expiresAt).toUTCString()}`,
      ].join("\n")).join("\n\n");
      await b.sendMessage(chatId,
        `⏳ <b>Pending Approvals (${pending.length})</b>\n\n${lines}\n\n<i>${utcNow()}</i>`,
        { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // /mode autonomous | /mode approval
  b.onText(/^\/mode(?:@\w+)?\s+(autonomous|approval)$/, async (msg, match) => {
    const chatId  = String(msg.chat.id);
    const newMode = match?.[1] as "autonomous" | "approval" | undefined;
    if (!newMode) {
      await b.sendMessage(chatId, "Usage: /mode autonomous  or  /mode approval");
      return;
    }
    try {
      await approvalGate.setMode(newMode);
      await b.sendMessage(chatId,
        `⚙️ Mode set to <b>${newMode}</b>\n<i>${utcNow()}</i>`,
        { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // /scan — Sprint 4 placeholder
  b.onText(/^\/scan(?:@\w+)?$/, async (msg) => {
    await b.sendMessage(String(msg.chat.id),
      `🔍 Market scan coming in Sprint 4.\n<i>${utcNow()}</i>`,
      { parse_mode: "HTML" });
  });

  // Free-text NL — route to AI assistant
  b.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = String(msg.chat.id);
    try {
      const ctx   = await buildContext();
      const reply = await generateAssistantReply(msg.text, ctx);
      await b.sendMessage(chatId, reply.message);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  b.startPolling();
  console.log("[telegram] Bot polling started");
}
