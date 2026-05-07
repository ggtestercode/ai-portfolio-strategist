import TelegramBot from "node-telegram-bot-api";
import { approvalGate, type PendingApproval } from "../lib/approvalGate";
import {
  generateAssistantReply,
  getCachedContext,
  syncHoldingsFromEtoro,
  syncAllHoldingsToDB,
  getPendingOrders,
  removePendingOrder,
  type AssistantContext,
} from "../lib/aiResponder";
import { getPortfolioSnapshot }            from "../lib/portfolio";
import { runScan, type Recommendation, type ScanResult } from "../lib/marketScanner";
import { rebalanceNow }                    from "../lib/rebalancer";
import { getWatchlist, addToWatchlist, removeFromWatchlist } from "../lib/watchlist";
import { getPortfolio, getOrders as etoroGetOrders, getPositionsWithSymbols as etoroGetPositions } from "../brokers/etoro";
import {
  getPositions as okxGetPositions,
  getOrders    as okxGetOrders,
  cancelOrder,
  cancelAllOrders as okxCancelAllOrders,
  getAccountBalance,
  testConnection as okxTestConnection,
} from "../brokers/okx";
import {
  getPositionsPaper,
  getBalancePaper,
} from "../brokers/okxPaper";
import {
  getPositions as bybitGetPositions,
  getBalance   as bybitGetBalance,
  getTicker    as bybitGetTicker,
  getOrders,
} from "../brokers/bybit";
import { okxPaperMode } from "../lib/startup";
import {
  registerScanNotifier,
  registerAlertNotifier,
  setCronEnabled,
  resumeTrading,
  triggerNow,
  getStatus as getCronStatus,
} from "../lib/cronScanner";
import {
  getPortfolioLeverage,
  getSuspendedCoins,
  unsuspendCoin,
  registerLeverageAlert,
} from "../lib/leverageManager";
import { startWatchdog, registerWatchdogAlert } from "../lib/watchdog";
import { getRecentTrades, getOpenTrades, getRecentMemory, getDailyPnl } from "../lib/tradeMemoryLib";
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

/** Strip exchange-specific suffixes for display (e.g. "QCOM-USDT" → "QCOM"). */
function displaySymbol(symbol: string): string {
  return symbol.replace(/[-/]?(USDT|USDC|USD)$/i, "");
}

const REC_EMOJI: Record<Recommendation, string> = {
  "STRONG BUY": "🟢",
  "BUY":        "🟡",
  "WATCH":      "🔵",
  "AVOID":      "🔴",
};

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
  const clw    = approval.capitalLimitWarning;
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!chatId) throw new Error("TELEGRAM_CHAT_ID env var is required");

  const symDisplay = displaySymbol(proposal.symbol);

  let text: string;
  let approveLabel: string;

  if (clw) {
    const xLabel = `${clw.multiple.toFixed(1)}x`;
    const lines: string[] = [];
    if (clw.autoModeOverride) {
      lines.push(`⚠️ <b>Auto mode overridden</b>`);
      lines.push(`Trade exceeds capital limit, manual approval required`);
      lines.push(``);
    }
    lines.push(
      `⚠️ <b>Trade exceeds 50% capital limit</b>`,
      ``,
      `<b>${proposal.side.toUpperCase()} ${escapeHtml(symDisplay)}</b>`,
      `Amount: <b>$${proposal.amountUsd.toLocaleString("en-US")}</b> (exceeds $${clw.capLimit.toFixed(0)} limit)`,
      ``,
      `This is <b>${xLabel}</b> your normal limit.`,
      `Do you want to proceed?`,
      ``,
      `ID: <code>${proposal.id}</code>`,
      `<i>Expires in 15 min · ${utcNow()}</i>`,
    );
    text         = lines.join("\n");
    approveLabel = "✅ Approve anyway";
  } else {
    text = [
      `🔔 <b>Trade Approval Required</b>`,
      `<b>${proposal.side.toUpperCase()} ${escapeHtml(symDisplay)}</b> — $${proposal.amountUsd}`,
      `Broker: ${proposal.broker} | Asset: ${escapeHtml(proposal.assetClass)}`,
      ``,
      escapeHtml(summary),
      ``,
      `ID: <code>${proposal.id}</code>`,
      `Expires: ${new Date(expiresAt).toUTCString()}`,
      `<i>${utcNow()}</i>`,
    ].join("\n");
    approveLabel = "✅ Approve";
  }

  const sentMsg = await getBot().sendMessage(chatId, text, {
    parse_mode: "HTML",
    reply_markup: {
      inline_keyboard: [[
        { text: approveLabel, callback_data: `approve:${proposal.id}` },
        { text: "❌ Reject",  callback_data: `reject:${proposal.id}`  },
      ]],
    },
  });

  // Capital-limit approvals: auto-expire and edit message after 15 min with no response
  if (clw && sentMsg?.message_id) {
    const msgId = sentMsg.message_id;
    setTimeout(async () => {
      const stillPending = approvalGate.getPending().some(p => p.proposal.id === proposal.id);
      if (stillPending) {
        await approvalGate.reject(proposal.id).catch(() => {});
        await getBot().editMessageText(
          `❌ <b>Approval timeout</b> — trade cancelled\n<i>${utcNow()}</i>`,
          { chat_id: chatId, message_id: msgId, parse_mode: "HTML" },
        ).catch(() => {});
      }
    }, 15 * 60 * 1000);
  }
};

// ── Cron scanner notification ────────────────────────────────────────────────

async function notifyScanComplete(result: ScanResult, triggered: "cron" | "manual"): Promise<void> {
  const label = triggered === "manual" ? "Manual Scan" : "Auto Scan";
  const top   = result.opportunities.slice(0, 5);

  if (!top.length) {
    await send(
      `🔍 <b>${label}</b> — No signals found\n<i>${utcNow()}</i>`,
      { parse_mode: "HTML" }
    );
    return;
  }

  const lines = top.map((o, i) => {
    const emoji = REC_EMOJI[o.recommendation as Recommendation] ?? "⚪";
    return [
      `${i + 1}. ${emoji} <b>${escapeHtml(o.symbol)}</b> — ${o.recommendation} (${o.score})`,
      `$${o.price.toLocaleString("en-US", { maximumFractionDigits: 4 })} · <i>${new Date(o.dataTimestamp).toUTCString()}</i>`,
      escapeHtml(o.reasoning),
    ].join("\n");
  }).join("\n\n");

  await send([
    `🔍 <b>${label} Results</b>`,
    `<i>${new Date(result.scanTimestamp).toUTCString()}</i>`,
    ``,
    lines,
    ``,
    `<i>${escapeHtml(result.summary)}</i>`,
  ].join("\n"), { parse_mode: "HTML" });
}

export function startPolling(): void {
  const b = getBot();

  // Register bot command list (shows when user types "/" in Telegram)
  b.setMyCommands([
    { command: "positions",  description: "View open positions (Bybit, OKX, eToro)" },
    { command: "orders",     description: "View pending orders" },
    { command: "balance",    description: "Account balance across brokers" },
    { command: "scan",       description: "Run live market scan (Claude)" },
    { command: "autoscan",   description: "Auto-scanner: on | off | now | status" },
    { command: "sync",       description: "Sync all brokers to local DB" },
    { command: "closedust",    description: "Close all dust positions (value < $1)" },
    { command: "cancelorders", description: "Cancel orders: list / BTC / buy BTC / all" },
    { command: "status",     description: "Full bot status overview" },
    { command: "history",    description: "Last 10 closed trades" },
    { command: "memory",     description: "Last 5 trade reflections (AI journal)" },
    { command: "pending",    description: "Pending trade approvals" },
    { command: "mode",       description: "Operation mode: autonomous | approval" },
    { command: "capital",    description: "View or set total capital (/capital 500)" },
    { command: "watchlist",  description: "View watchlist" },
    { command: "add",        description: "Add symbol to watchlist (/add BTC Crypto)" },
    { command: "remove",     description: "Remove symbol from watchlist" },
    { command: "rebalance",  description: "Propose portfolio rebalance trades" },
    { command: "resume",     description: "Resume trading after pause (/resume [COIN])" },
    { command: "okxtest",    description: "Test OKX API connection" },
  ]).catch(e => console.warn("[telegram] setMyCommands failed:", e));

  // Register all callbacks
  registerScanNotifier(notifyScanComplete);
  const alertHandler: (msg: string) => Promise<void> = async (msg) => send(escapeHtml(msg), { parse_mode: "HTML" });
  registerAlertNotifier(alertHandler);
  registerLeverageAlert(alertHandler);
  registerWatchdogAlert(alertHandler);
  startWatchdog();

  // ── Inline button callbacks — approve / reject ───────────────────────────
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

      let replyText: string;

      if (action === "reject") {
        replyText = `❌ ${escapeHtml(result.message)}\n<i>${utcNow()}</i>`;
      } else if (result.action === "executed") {
        const p      = result.proposal;
        const base   = p.symbol.includes("-") ? (p.symbol.split("-")[0] ?? p.symbol) : p.symbol;
        const isBybit = p.broker === "bybit";
        const isOKX   = p.broker === "okx";
        const leverage = isBybit ? 10 : 1;
        const exposure = (p.amountUsd * leverage).toFixed(0);

        let price: number | null = null;
        try {
          if (isBybit) {
            const ticker = await bybitGetTicker(p.symbol);
            price = ticker.lastPrice;
          } else if (isOKX) {
            const okxBase = process.env["OKX_BASE_URL"] ?? "https://www.okx.com";
            const tr = await fetch(
              `${okxBase}/api/v5/market/ticker?instId=${encodeURIComponent(p.symbol)}`,
              { signal: AbortSignal.timeout(4000) }
            );
            const tj = await tr.json() as { code: string; data: Array<{ last: string }> };
            if (tj.code === "0" && tj.data[0]) price = parseFloat(tj.data[0].last);
          }
        } catch { /* price is optional */ }

        const priceStr  = price ? `$${price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : null;
        const notional  = p.amountUsd * leverage;
        const unitsStr  = price ? `~${(notional / price).toFixed(4)} ${base}` : null;

        const lines: (string | null)[] = [
          `✅ <b>${p.side.toUpperCase()} ${escapeHtml(p.symbol)}</b> — Executed`,
          result.orderId ? `Order ID: <code>${result.orderId}</code>` : null,
        ];

        if (isBybit) {
          const mode = (process.env["BYBIT_TRADING_MODE"] ?? "testnet") === "live" ? "Live" : "Testnet";
          lines.push(`Amount: $${p.amountUsd} at ${leverage}x`);
          lines.push(`Exposure: $${exposure}`);
          if (unitsStr)  lines.push(`Units: ${unitsStr}`);
          lines.push(`Broker: Bybit ${mode}`);
          if (priceStr)  lines.push(`Price: ${priceStr}`);
        } else if (isOKX) {
          const okxMode = okxPaperMode ? "Paper" : (process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live");
          lines.push(`Amount: $${p.amountUsd} (spot)`);
          if (unitsStr)  lines.push(`Units: ${unitsStr}`);
          lines.push(`Broker: OKX ${okxMode}`);
          if (priceStr)  lines.push(`Price: ${priceStr}`);
        } else {
          lines.push(`Amount: $${p.amountUsd}`);
        }
        lines.push(`<i>${utcNow()}</i>`);

        replyText = lines.filter(Boolean).join("\n");
      } else {
        replyText = `⚠️ ${escapeHtml(result.message)}\n<i>${utcNow()}</i>`;
      }

      await b.editMessageText(replyText,
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

  // ── /pending ─────────────────────────────────────────────────────────────
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

  // ── /mode — show current mode (no arg) or set mode ───────────────────────
  b.onText(/^\/mode(?:@\w+)?(?:\s+(autonomous|approval))?$/, async (msg, match) => {
    const chatId  = String(msg.chat.id);
    const newMode = match?.[1] as "autonomous" | "approval" | undefined;
    try {
      if (!newMode) {
        const { mode, thresholdUsd } = await approvalGate.getConfig();
        await b.sendMessage(chatId,
          `⚙️ <b>Operation Mode</b>\n\nCurrent mode: <b>${mode}</b>\nApproval threshold: <b>$${thresholdUsd}</b>\n\nTo change: /mode autonomous  or  /mode approval`,
          { parse_mode: "HTML" });
        return;
      }
      await approvalGate.setMode(newMode);
      await b.sendMessage(chatId,
        `⚙️ Mode set to <b>${newMode}</b>\n<i>${utcNow()}</i>`,
        { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /scan — live Claude market analysis ──────────────────────────────────
  b.onText(/^\/scan(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      await b.sendMessage(chatId, `🔍 Running market scan… <i>this takes ~20 s</i>`, { parse_mode: "HTML" });
      const result = await runScan();

      if (!result.opportunities.length) {
        await b.sendMessage(chatId,
          `⚠️ Scan returned no results.\n<i>${utcNow()}</i>`,
          { parse_mode: "HTML" });
        return;
      }

      const top5 = result.opportunities.slice(0, 5);
      const lines = top5.map((o, i) => {
        const emoji = REC_EMOJI[o.recommendation as Recommendation] ?? "⚪";
        return [
          `${i + 1}. ${emoji} <b>${escapeHtml(o.symbol)}</b> — ${o.recommendation} (score: ${o.score})`,
          `$${o.price.toLocaleString("en-US", { maximumFractionDigits: 4 })} | data: <i>${new Date(o.dataTimestamp).toUTCString()}</i>`,
          escapeHtml(o.reasoning),
        ].join("\n");
      }).join("\n\n");

      await b.sendMessage(chatId, [
        `🔍 <b>Market Scan — Top 5 Picks</b>`,
        `<i>${new Date(result.scanTimestamp).toUTCString()}</i>`,
        ``,
        lines,
        ``,
        `<i>${escapeHtml(result.summary)}</i>`,
      ].join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ Scan failed: ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /rebalance — propose rebalance trades ────────────────────────────────
  b.onText(/^\/rebalance(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      await b.sendMessage(chatId, `⚖️ Analysing portfolio drift…`, { parse_mode: "HTML" });
      const result = await rebalanceNow();

      if (!result.trades.length) {
        await b.sendMessage(chatId,
          `✅ Portfolio is balanced — no trades needed.\n<i>${utcNow()}</i>`,
          { parse_mode: "HTML" });
        return;
      }

      const tradeLines = result.trades.map((t, i) =>
        `${i + 1}. <b>${t.side.toUpperCase()} ${escapeHtml(t.symbol)}</b> $${t.amountUsd.toFixed(0)}\n   ${escapeHtml(t.rationale)}`
      ).join("\n\n");

      await b.sendMessage(chatId, [
        `⚖️ <b>Rebalance Proposed (${result.trades.length} trades)</b>`,
        `<i>${new Date(result.timestamp).toUTCString()}</i>`,
        ``,
        tradeLines,
        ``,
        `<i>${escapeHtml(result.summary)}</i>`,
        ``,
        `Trades queued for approval.`,
      ].join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ Rebalance failed: ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /watchlist ────────────────────────────────────────────────────────────
  b.onText(/^\/watchlist(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const list = await getWatchlist();
      const grouped: Record<string, string[]> = {};
      for (const e of list) {
        (grouped[e.assetClass] ??= []).push(e.symbol);
      }
      const lines = Object.entries(grouped).map(([cls, syms]) =>
        `<b>${escapeHtml(cls)}</b> (${syms.length}): ${syms.map(escapeHtml).join(" ")}`
      ).join("\n\n");

      await b.sendMessage(chatId, [
        `📋 <b>Watchlist (${list.length} assets)</b>`,
        `<i>${utcNow()}</i>`,
        ``,
        lines,
      ].join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /add SYMBOL [assetClass] ─────────────────────────────────────────────
  b.onText(/^\/add(?:@\w+)?\s+(\S+)(?:\s+(\S+))?$/, async (msg, match) => {
    const chatId     = String(msg.chat.id);
    const symbol     = match?.[1]?.toUpperCase() ?? "";
    const assetClass = match?.[2] ?? "Equity";
    if (!symbol) { await b.sendMessage(chatId, "Usage: /add SYMBOL [assetClass]"); return; }
    try {
      await addToWatchlist(symbol, assetClass);
      await b.sendMessage(chatId,
        `✅ <b>${escapeHtml(symbol)}</b> added to watchlist as <i>${escapeHtml(assetClass)}</i>\n<i>${utcNow()}</i>`,
        { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /remove SYMBOL ────────────────────────────────────────────────────────
  b.onText(/^\/remove(?:@\w+)?\s+(\S+)$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const symbol = match?.[1]?.toUpperCase() ?? "";
    if (!symbol) { await b.sendMessage(chatId, "Usage: /remove SYMBOL"); return; }
    try {
      const removed = await removeFromWatchlist(symbol);
      await b.sendMessage(chatId,
        removed
          ? `✅ <b>${escapeHtml(symbol)}</b> removed from watchlist.\n<i>${utcNow()}</i>`
          : `⚠️ <b>${escapeHtml(symbol)}</b> was not in the watchlist.`,
        { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /capital [amount] — view or update totalCapital ─────────────────────
  b.onText(/^\/capital(?:\s+(.+))?$/i, async (msg, match) => {
    const chatId = String(msg.chat.id);
    try {
      const arg = match?.[1]?.trim();
      if (!arg) {
        const [row] = await db.select({ totalCapital: profileTable.totalCapital }).from(profileTable).limit(1);
        const cap = row?.totalCapital ?? 0;
        await b.sendMessage(chatId,
          `💰 <b>Capital</b>\n\nTotal capital: <b>$${cap.toLocaleString()}</b>\nMax single trade: <b>$${(cap * 0.5).toLocaleString()}</b> (50% limit)`,
          { parse_mode: "HTML" });
        return;
      }
      const amount = parseFloat(arg.replace(/[$,]/g, ""));
      if (isNaN(amount) || amount <= 0) {
        await b.sendMessage(chatId, "❌ Invalid amount. Usage: <code>/capital 500</code>", { parse_mode: "HTML" });
        return;
      }
      await db.update(profileTable).set({ totalCapital: amount });
      await b.sendMessage(chatId,
        `✅ <b>Capital updated</b>\n\nTotal capital: <b>$${amount.toLocaleString()}</b>\nMax single trade: <b>$${(amount * 0.5).toLocaleString()}</b> (50% limit)\n\n<i>${utcNow()}</i>`,
        { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /sync — rebuild local DB from all brokers ────────────────────────────
  b.onText(/^\/sync(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const [, bybitPos, okxPos, etoroPos] = await Promise.all([
        syncAllHoldingsToDB().catch(() => {}),
        bybitGetPositions().catch(() => []),
        okxPaperMode ? getPositionsPaper().catch(() => []) : okxGetPositions().catch(() => []),
        etoroGetPositions().catch(() => []),
      ]);

      // Detect dust (OKX only — eToro doesn't report current value directly)
      const dustOkx = okxPos.filter(p => (p.entryPrice * p.size + p.pnl) < 1);
      const now = new Date().toLocaleTimeString("en-SG", {
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore",
      }) + " SGT";

      const etoroSymCount = new Set(etoroPos.map(p => p.symbol.replace(/[-/]?(USDT|USDC|USD)$/i, "").toUpperCase())).size;
      const lines = [
        `🔄 <b>Synced — ${okxPos.length + bybitPos.length + etoroSymCount} positions found</b>`,
        ``,
        `Bybit: <b>${bybitPos.length}</b>`,
        `OKX: <b>${okxPos.length}</b>`,
        `eToro: <b>${etoroSymCount}</b>`,
        `Time: ${now}`,
      ];

      if (dustOkx.length) {
        const dustList = dustOkx.map(p => {
          const val = (p.entryPrice * p.size + p.pnl).toFixed(2);
          return `${displaySymbol(p.symbol)} $${val}`;
        }).join(", ");
        lines.push(``, `⚠️ <b>${dustOkx.length} dust position(s) (&lt;$1):</b>`);
        lines.push(`<code>${escapeHtml(dustList)}</code>`);
        lines.push(`Reply /closedust to close them`);
      }

      await b.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ Sync failed: ${escapeHtml(m)}`);
    }
  });

  // ── /closedust — close all OKX positions with value < $1 ─────────────────
  b.onText(/^\/closedust(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const okxPos = okxPaperMode
        ? await getPositionsPaper().catch(() => [])
        : await okxGetPositions().catch(() => []);

      const dustPos = okxPos.filter(p => (p.entryPrice * p.size + p.pnl) < 1);
      if (!dustPos.length) {
        await b.sendMessage(chatId, `✅ No dust positions found (all positions ≥ $1).`);
        return;
      }

      await b.sendMessage(chatId,
        `🧹 Closing ${dustPos.length} dust position(s)...`,
        { parse_mode: "HTML" });

      const { closePosition: okxClose } = await import("../brokers/okx");
      const { closePositionPaper }      = await import("../brokers/okxPaper");

      for (const p of dustPos) {
        const sym = escapeHtml(displaySymbol(p.symbol));
        const val = (p.entryPrice * p.size + p.pnl).toFixed(4);
        try {
          if (okxPaperMode) await closePositionPaper(p.symbol);
          else              await okxClose(p.symbol);
          await b.sendMessage(chatId, `✅ Closed ${sym} ($${val})`, { parse_mode: "HTML" });
        } catch (e) {
          const em = e instanceof Error ? e.message : String(e);
          // Below minimum lot size — OKX cannot close it via API; it will expire worthless
          if (em.includes("no valid quote currency")) {
            await b.sendMessage(chatId,
              `⚠️ ${sym} ($${val}) — below minimum lot size, cannot close via API. Will be ignored in dashboard.`,
              { parse_mode: "HTML" });
          } else {
            await b.sendMessage(chatId,
              `❌ Failed to close ${sym}: ${escapeHtml(em)}`,
              { parse_mode: "HTML" });
          }
        }
      }

      await syncAllHoldingsToDB().catch(() => {});
      await b.sendMessage(chatId, `🧹 Done. Use /positions to verify (sub-$1 positions are filtered from display).`);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ /closedust failed: ${escapeHtml(m)}`);
    }
  });

  // ── /positions — OKX + eToro combined ────────────────────────────────────
  b.onText(/^\/positions(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const [okxPos, bybitPos, etoroRawPos, localPending] = await Promise.all([
        okxPaperMode ? getPositionsPaper().catch(() => []) : okxGetPositions().catch(() => []),
        bybitGetPositions().catch(() => []),
        etoroGetPositions().catch(() => []),
        Promise.resolve(getPendingOrders()),
      ]);

      const now = new Date().toLocaleTimeString("en-SG", {
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore",
      }) + " SGT";

      if (!okxPos.length && !bybitPos.length && !etoroRawPos.length && !localPending.length) {
        await b.sendMessage(chatId,
          `📊 No open positions or pending orders.\n<i>Last synced: ${now}</i>`,
          { parse_mode: "HTML" });
        return;
      }

      const out: string[] = [`📊 <b>Positions</b>`, ``];

      if (bybitPos.length) {
        const isTestnet = (process.env["BYBIT_TRADING_MODE"] ?? "testnet") !== "live";
        const mode = isTestnet ? "Testnet" : "Live";
        out.push(`<b>Bybit ${mode} (${bybitPos.length}):</b>`);
        for (const p of bybitPos) {
          const sign        = p.pnl >= 0 ? "+" : "";
          const pnlStr      = p.pnl !== 0 ? ` · P/L ${sign}$${p.pnl.toFixed(2)} (${sign}${p.pnlPct.toFixed(2)}%)` : "";
          const testnetNote = isTestnet ? " ⚠️ testnet price" : "";
          out.push(`• <b>${escapeHtml(p.symbol)}</b> — ${p.size} · ${p.side} · ${p.leverage}x · entry $${p.entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}${testnetNote}${pnlStr}`);
        }
        out.push(``);
      }

      if (okxPos.length) {
        const mode = okxPaperMode ? "Paper" : (process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live");
        const significantOkx = okxPos.filter(p => (p.entryPrice * p.size + p.pnl) >= 1);
        const dustOkxCount   = okxPos.length - significantOkx.length;
        out.push(`<b>OKX ${mode} (${significantOkx.length}):</b>`);
        for (const p of significantOkx) {
          const sign         = p.pnl >= 0 ? "+" : "";
          const base         = p.symbol.split("-")[0] ?? p.symbol;
          const sizeStr      = `${p.size.toFixed(6)} ${base}`;
          const currentValue = p.entryPrice * p.size + p.pnl;
          const valueStr     = `$${currentValue.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
          const pnlStr       = p.pnl !== 0 ? ` · P/L ${sign}$${p.pnl.toFixed(2)} (${sign}${p.pnlPct.toFixed(2)}%)` : "";
          out.push(`• <b>${escapeHtml(p.symbol)}</b> — ${sizeStr} · value ${valueStr} · entry $${p.entryPrice.toLocaleString("en-US", { maximumFractionDigits: 2 })}${pnlStr}`);
        }
        if (dustOkxCount > 0) out.push(`<i>⚠️ ${dustOkxCount} dust position(s) hidden (value &lt; $1) — use /closedust to clean up</i>`);
        out.push(``);
      }

      if (etoroRawPos.length) {
        // Aggregate by symbol, filter dust
        const etoroAgg = new Map<string, { value: number; profit: number; openRate: number }>();
        for (const p of etoroRawPos) {
          const sym = p.symbol.replace(/[-/]?(USDT|USDC|USD)$/i, "").toUpperCase();
          const cur = etoroAgg.get(sym) ?? { value: 0, profit: 0, openRate: p.openRate };
          etoroAgg.set(sym, { value: cur.value + p.amountUsd, profit: cur.profit + p.profit, openRate: cur.openRate });
        }
        const significantEtoro = [...etoroAgg.entries()].filter(([, d]) => d.value >= 1);
        const dustEtoroCount   = etoroAgg.size - significantEtoro.length;
        out.push(`<b>eToro Demo (${significantEtoro.length}):</b>`);
        for (const [sym, d] of significantEtoro) {
          const sign  = d.profit >= 0 ? "+" : "";
          const entry = d.openRate ? ` · entry $${d.openRate.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "";
          out.push(`• <b>${escapeHtml(sym)}</b> — $${d.value.toFixed(2)} long${entry} · P/L ${sign}$${d.profit.toFixed(2)}`);
        }
        if (dustEtoroCount > 0) out.push(`<i>⚠️ ${dustEtoroCount} dust position(s) hidden (value &lt; $1) — use /closedust to clean up</i>`);
        out.push(``);
      }

      if (localPending.length) {
        out.push(`<b>Pending (${localPending.length}):</b>`);
        for (const o of localPending) {
          const t = o.queuedAt.toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" }) + " SGT";
          out.push(`• <b>${escapeHtml(o.symbol)}</b> — ${o.side.toUpperCase()} $${o.amountUsd} [${o.broker}] · placed ${t} · waiting for market open`);
        }
        out.push(``);
      }

      out.push(`<i>Last synced: ${now}</i>`);
      await b.sendMessage(chatId, out.join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ /positions failed: ${escapeHtml(m)}`);
    }
  });

  // ── /orders — pending orders from Bybit + OKX + eToro + in-memory ──────────
  b.onText(/^\/orders(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const [bybitOrders, okxOrders, etoroOrders, localPending] = await Promise.all([
        getOrders().catch(() => []),
        okxGetOrders().catch(() => []),
        etoroGetOrders().catch(() => []),
        Promise.resolve(getPendingOrders()),
      ]);

      type Row = { id: string; symbol: string; side: string; amountUsd: number; broker: string; placedAt?: string };
      const map = new Map<string, Row>();
      for (const o of bybitOrders)  map.set(o.orderId, { id: o.orderId, symbol: o.symbol, side: o.side, amountUsd: o.qty * o.price, broker: "bybit", placedAt: o.placedAt });
      for (const o of okxOrders)    map.set(o.orderId, { id: o.orderId, symbol: o.symbol, side: o.side, amountUsd: o.price > 0 && o.size > 0 ? o.price * o.size : 0, broker: "okx", placedAt: o.placedAt });
      for (const o of etoroOrders)  map.set(o.orderId, { id: o.orderId, symbol: o.symbol, side: o.side, amountUsd: o.amountUsd, broker: "etoro", placedAt: o.placedAt });
      for (const o of localPending) if (!map.has(o.id)) map.set(o.id, { id: o.id, symbol: o.symbol, side: o.side, amountUsd: o.amountUsd, broker: o.broker, placedAt: o.queuedAt.toISOString() });
      const orders = Array.from(map.values());

      if (!orders.length) {
        await b.sendMessage(chatId, `📋 No pending orders.\n<i>${utcNow()}</i>`, { parse_mode: "HTML" });
        return;
      }

      const lines = orders.map(o => {
        const t = o.placedAt
          ? new Date(o.placedAt).toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" }) + " SGT"
          : "recently";
        const amtStr = o.amountUsd > 0 ? ` $${o.amountUsd.toFixed(2)}` : "";
        return `• <b>${escapeHtml(o.symbol)}</b> — ${o.side.toUpperCase()}${amtStr} [${o.broker}] · placed ${t}`;
      }).join("\n");

      await b.sendMessage(chatId, [
        `📋 <b>Pending Orders (${orders.length})</b>`,
        ``,
        lines,
        ``,
        `<i>${utcNow()}</i>`,
      ].join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ /orders failed: ${escapeHtml(m)}`);
    }
  });

  // ── /cancelorders [symbol|buy BTC|all] ───────────────────────────────────
  b.onText(/^\/cancelorders(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId  = String(msg.chat.id);
    const rawArg  = match?.[1]?.trim();
    const okxMode = okxPaperMode ? "Paper" : (process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live");

    function fmtOrder(o: { symbol: string; side: string; price: number; size: number; placedAt: string }): string {
      const t   = new Date(o.placedAt).toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" }) + " SGT";
      const amt = o.price > 0 && o.size > 0 ? ` $${(o.price * o.size).toFixed(2)}` : "";
      const px  = o.price > 0 ? ` @ $${o.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "";
      return `${escapeHtml(o.symbol)} ${o.side.toUpperCase()}${amt}${px} · ${t}`;
    }

    try {
      const [okxOrders, local] = await Promise.all([
        okxGetOrders().catch(() => [] as Awaited<ReturnType<typeof okxGetOrders>>),
        Promise.resolve(getPendingOrders()),
      ]);

      // No arg — list orders
      if (!rawArg) {
        if (!okxOrders.length && !local.length) {
          await b.sendMessage(chatId, `📋 No open orders.\n<i>${utcNow()}</i>`, { parse_mode: "HTML" });
          return;
        }
        const lines: string[] = [`📋 <b>Open orders</b> — use <code>/cancelorders BTC</code> or <code>/cancelorders all</code>`, ``];
        for (const o of okxOrders) lines.push(`• ${fmtOrder(o)} [OKX ${okxMode}]`);
        for (const o of local)     lines.push(`• ${escapeHtml(o.symbol)} ${o.side.toUpperCase()} $${o.amountUsd} [local] · queued`);
        await b.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
        return;
      }

      // "all" — cancel everything
      if (rawArg.toLowerCase() === "all") {
        const [cancelledCount] = await Promise.all([
          okxCancelAllOrders().catch(() => 0),
        ]);
        const localCount = local.length;
        for (const o of local) removePendingOrder(o.id);
        await b.sendMessage(chatId, [
          `✅ <b>All orders cancelled</b>`,
          `OKX ${okxMode}: <b>${cancelledCount}</b> cancelled`,
          `Local queue: <b>${localCount}</b> cleared`,
          `<i>${utcNow()}</i>`,
        ].join("\n"), { parse_mode: "HTML" });
        return;
      }

      // Parse "buy BTC", "sell ETH", or just "BTC"
      const parts  = rawArg.toUpperCase().split(/\s+/);
      let side: string | null = null;
      let sym: string;
      if (parts[0] === "BUY" || parts[0] === "SELL") {
        side = parts[0].toLowerCase();
        sym  = (parts[1] ?? "").replace(/-USDT$/, "").replace(/-USDC$/, "");
      } else {
        sym = parts[0]!.replace(/-USDT$/, "").replace(/-USDC$/, "");
      }

      // Match OKX orders by base symbol (and optionally side)
      const matches = okxOrders.filter(o => {
        const base = o.symbol.split("-")[0]?.toUpperCase() ?? "";
        return base === sym && (!side || o.side === side);
      });
      // Also match local pending
      const localMatches = local.filter(o => {
        const base = o.symbol.split("-")[0]?.toUpperCase().replace(/USDT$/, "") ?? "";
        return (base === sym || o.symbol.toUpperCase() === sym) && (!side || o.side === side);
      });

      if (!matches.length && !localMatches.length) {
        await b.sendMessage(chatId,
          `❌ No open orders found for <b>${escapeHtml(sym)}</b>${side ? ` (${side})` : ""}.\nUse /cancelorders to list all.`,
          { parse_mode: "HTML" });
        return;
      }

      // Cancel all matches
      const results: string[] = [];
      for (const o of matches) {
        await cancelOrder(o.symbol, o.orderId).catch(() => {});
        results.push(`✅ Cancelled ${fmtOrder(o)}`);
      }
      for (const o of localMatches) {
        removePendingOrder(o.id);
        results.push(`✅ Cancelled ${escapeHtml(o.symbol)} ${o.side.toUpperCase()} $${o.amountUsd} [local]`);
      }
      await b.sendMessage(chatId, results.join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ /cancelorders failed: ${escapeHtml(m)}`);
    }
  });

  // ── /balance — Bybit + OKX + eToro account balances ─────────────────────────
  b.onText(/^\/balance(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const [bybitBal, okxBal, etoroPortfolio] = await Promise.all([
        bybitGetBalance().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
        okxPaperMode
          ? getBalancePaper().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) }))
          : getAccountBalance().catch((e: unknown) => ({ error: e instanceof Error ? e.message : String(e) })),
        getPortfolio().catch(() => null),
      ]);

      interface EtoroPortfolio {
        clientPortfolio?: {
          credit?:    number;
          positions?: Array<{ amount?: number }>;
          [k: string]: unknown;
        };
        [k: string]: unknown;
      }
      const cp           = (etoroPortfolio as EtoroPortfolio | null)?.clientPortfolio;
      const etoroCash    = cp?.credit ?? 0;
      const etoroInvested = (cp?.positions ?? []).reduce((s, p) => s + (p.amount ?? 0), 0);
      const etoroTotal   = etoroCash + etoroInvested;

      const out: string[] = [`💰 <b>Account Balance</b>`, ``];

      const bybitMode = (process.env["BYBIT_TRADING_MODE"] ?? "testnet") === "live" ? "Live" : "Testnet";
      if ("error" in bybitBal) {
        out.push(`<b>Bybit ${bybitMode}:</b> ❌ ${escapeHtml(bybitBal.error)}`, ``);
      } else {
        out.push(
          `<b>Bybit ${bybitMode}:</b>`,
          `Total equity: <b>$${bybitBal.totalEquity.toFixed(2)}</b>`,
          `Available: <b>$${bybitBal.availableBalance.toFixed(2)}</b>`,
          ``
        );
      }

      const okxMode = okxPaperMode ? "Paper" : (process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live");
      if ("error" in okxBal) {
        out.push(`<b>OKX ${okxMode}:</b> ❌ ${escapeHtml(okxBal.error)}`, ``);
      } else {
        out.push(
          `<b>OKX ${okxMode}:</b>`,
          `Total equity: <b>$${okxBal.totalEquity.toFixed(2)}</b>`,
          `Available: <b>$${okxBal.availableBalance.toFixed(2)}</b>`,
          ``
        );
      }

      out.push(
        `<b>eToro Demo:</b>`,
        `Cash: <b>$${etoroCash.toFixed(2)}</b>`,
        `Invested: <b>$${etoroInvested.toFixed(2)}</b>`,
        `Total: <b>$${etoroTotal.toFixed(2)}</b>`,
        ``
      );

      const bybitTotal = "error" in bybitBal ? 0 : bybitBal.totalEquity;
      const okxTotal   = "error" in okxBal   ? 0 : okxBal.totalEquity;
      out.push(
        `Combined: <b>$${(bybitTotal + okxTotal + etoroTotal).toFixed(2)}</b>`,
        `<i>${utcNow()}</i>`,
      );

      await b.sendMessage(chatId, out.join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ /balance failed: ${escapeHtml(m)}`);
    }
  });

  // ── /okxtest — verify OKX API credentials ────────────────────────────────
  b.onText(/^\/okxtest(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const result = await okxTestConnection();
      const icon   = result.ok ? "✅" : "❌";
      const output = [
        `${icon} <b>OKX Connection Test</b>`,
        ...result.lines.map(l => l ? escapeHtml(l) : ""),
      ].join("\n");
      await b.sendMessage(chatId, output, { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`);
    }
  });

  // ── /autoscan [on|off|now|status] ────────────────────────────────────────
  b.onText(/^\/autoscan(?:@\w+)?(?:\s+(on|off|now|status))?$/i, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const arg    = match?.[1]?.toLowerCase();
    try {
      if (!arg || arg === "status") {
        const s       = getCronStatus();
        const lastStr = s.lastScan
          ? s.lastScan.toLocaleString("en-SG", { timeZone: "Asia/Singapore", hour12: false }) + " SGT"
          : "Never";
        const lines = [
          `🤖 <b>Auto-Scanner</b>`,
          ``,
          `Cron:    <b>${s.enabled ? "✅ Enabled" : "⏸ Disabled"}</b>`,
          `Trading: <b>${s.paused  ? "🛑 Paused"  : "▶️ Active"}</b>`,
          `Schedule: <code>${escapeHtml(s.interval)}</code>`,
          `Last scan: ${lastStr}`,
        ];
        if (s.paused && s.pausedReason) {
          lines.push(``, escapeHtml(s.pausedReason));
        }
        lines.push(``, `Commands: /autoscan on · off · now`);
        await b.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
        return;
      }
      if (arg === "on") {
        setCronEnabled(true);
        await b.sendMessage(chatId,
          `✅ <b>Auto-scanner enabled</b>\n<i>${utcNow()}</i>`, { parse_mode: "HTML" });
        return;
      }
      if (arg === "off") {
        setCronEnabled(false);
        await b.sendMessage(chatId,
          `⏸ <b>Auto-scanner disabled</b>\n<i>${utcNow()}</i>`, { parse_mode: "HTML" });
        return;
      }
      if (arg === "now") {
        await b.sendMessage(chatId,
          `🔍 Triggering scan now… <i>(~20 s)</i>`, { parse_mode: "HTML" });
        triggerNow().catch(e => console.error("[telegram] /autoscan now:", e));
        return;
      }
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /resume [coin] — resume trading or unsuspend specific coin ───────────
  b.onText(/^\/resume(?:@\w+)?(?:\s+(\S+))?$/, async (msg, match) => {
    const chatId = String(msg.chat.id);
    const coin   = match?.[1]?.toUpperCase();
    if (coin) {
      await unsuspendCoin(coin);
      await b.sendMessage(chatId,
        `✅ <b>${escapeHtml(coin)}</b> unsuspended\n<i>${utcNow()}</i>`,
        { parse_mode: "HTML" });
    } else {
      resumeTrading();
      await b.sendMessage(chatId,
        `▶️ <b>Trading resumed</b> — daily loss limit overridden\n<i>${utcNow()}</i>`,
        { parse_mode: "HTML" });
    }
  });

  // ── /status — full bot status ─────────────────────────────────────────────
  b.onText(/^\/status(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const [snap, config, cron, leverage, suspended, dailyPnl, okxPos, bybitPos, etoroPos, localPending] =
        await Promise.all([
          getPortfolioSnapshot(0).catch(() => null),
          approvalGate.getConfig(),
          Promise.resolve(getCronStatus()),
          getPortfolioLeverage().catch(() => 10),
          getSuspendedCoins().catch(() => [] as string[]),
          getDailyPnl().catch(() => 0),
          okxPaperMode ? getPositionsPaper().catch(() => []) : okxGetPositions().catch(() => []),
          bybitGetPositions().catch(() => []),
          etoroGetPositions().catch(() => []),
          Promise.resolve(getPendingOrders()),
        ]);

      // Count unique eToro symbols
      const etoroSymbolCount = new Set(etoroPos.map(p => p.symbol.replace(/[-/]?(USDT|USDC|USD)$/i, "").toUpperCase())).size;

      const okxMode    = okxPaperMode ? "Paper" : (process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live");
      const bybitMode  = (process.env["BYBIT_TRADING_MODE"] ?? "testnet") === "live" ? "Live" : "Testnet";
      const openCount  = okxPos.length + bybitPos.length + etoroSymbolCount;
      const pnlSign    = dailyPnl >= 0 ? "+" : "";
      const dailyLimit = process.env["DAILY_LOSS_LIMIT_PCT"] ?? "30";
      const lastScan   = cron.lastScan
        ? cron.lastScan.toLocaleString("en-SG", { timeZone: "Asia/Singapore", hour12: false }) + " SGT"
        : "Never";

      await b.sendMessage(chatId, [
        `🤖 <b>Bot Status</b>`,
        `<i>${utcNow()}</i>`,
        ``,
        `Mode: <b>${config.mode}</b>`,
        `Trading: <b>${cron.paused ? "🛑 Paused" : "▶️ Active"}</b>`,
        `Auto-scanner: <b>${cron.enabled ? "✅ On" : "⏸ Off"}</b>`,
        `Schedule: <code>${escapeHtml(cron.interval)}</code>`,
        `Last scan: ${lastScan}`,
        ``,
        `💼 <b>Portfolio</b>`,
        snap ? `Total: <b>$${snap.totalValue.toFixed(2)}</b>` : "",
        `Daily P/L: <b>${pnlSign}$${dailyPnl.toFixed(2)}</b>`,
        ``,
        `📊 <b>Positions (${openCount} open)</b>`,
        `OKX ${okxMode}: <b>${okxPos.length}</b>`,
        `Bybit ${bybitMode}: <b>${bybitPos.length}</b>`,
        `eToro Demo: <b>${etoroSymbolCount}</b>`,
        `Pending approvals: <b>${localPending.length}</b>`,
        suspended.length ? `Suspended: <b>${suspended.map(escapeHtml).join(", ")}</b>` : "",
        ``,
        `⚙️ <b>Settings</b>`,
        `Portfolio leverage: <b>${leverage}x</b>`,
        `Daily P/L limit: <b>-${dailyLimit}%</b>`,
      ].filter(Boolean).join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /history — open + closed trades ─────────────────────────────────────
  b.onText(/^\/history(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const [openTrades, closedTrades] = await Promise.all([
        getOpenTrades(),
        getRecentTrades(10),
      ]);

      if (!openTrades.length && !closedTrades.length) {
        await b.sendMessage(chatId,
          `📋 No trade history yet. Trades are logged after you execute a buy or sell.\n<i>${utcNow()}</i>`,
          { parse_mode: "HTML" });
        return;
      }

      const out: string[] = [`📋 <b>Trade History</b>`, ``];

      if (openTrades.length) {
        out.push(`<b>Open (${openTrades.length}):</b>`);
        for (const t of openTrades) {
          const dir    = t.direction === "long" ? "▲" : "▼";
          const when   = t.entryAt.toLocaleString("en-SG", { timeZone: "Asia/Singapore", hour12: false }) + " SGT";
          const amt    = t.amountUsd ? ` · $${parseFloat(t.amountUsd).toFixed(0)}` : "";
          const ep     = t.entryPrice ? ` · entry $${parseFloat(t.entryPrice).toLocaleString("en-US", { maximumFractionDigits: 4 })}` : "";
          out.push(`• <b>${escapeHtml(t.symbol)}</b> ${dir} ${t.direction}${amt}${ep} · ${when} [${t.broker}]`);
        }
        out.push(``);
      }

      if (closedTrades.length) {
        out.push(`<b>Closed (last ${closedTrades.length}):</b>`);
        const lines = closedTrades.map((t, i) => {
          const pnl    = parseFloat(t.pnl  ?? "0");
          const pnlPct = parseFloat(t.pnlPct ?? "0");
          const sign   = pnl >= 0 ? "+" : "";
          const dir    = t.direction === "long" ? "▲" : "▼";
          const when   = t.exitAt
            ? t.exitAt.toLocaleString("en-SG", { timeZone: "Asia/Singapore", hour12: false }) + " SGT"
            : "—";
          return `${i + 1}. <b>${escapeHtml(t.symbol)}</b> ${dir} ${sign}$${pnl.toFixed(2)} (${sign}${pnlPct.toFixed(1)}%) · ${when} [${t.broker}]`;
        });
        out.push(...lines, ``);
      }

      out.push(`<i>${utcNow()}</i>`);
      await b.sendMessage(chatId, out.join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /memory — last 5 trade reflections ───────────────────────────────────
  b.onText(/^\/memory(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const memory = await getRecentMemory(5);
      await b.sendMessage(chatId, [
        `🧠 <b>Trade Memory</b>`,
        ``,
        escapeHtml(memory),
        ``,
        `<i>${utcNow()}</i>`,
      ].join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── Free-text NL — route to AI assistant ─────────────────────────────────
  b.on("message", async (msg) => {
    if (!msg.text || msg.text.startsWith("/")) return;
    const chatId = String(msg.chat.id);
    try {
      const ctx   = await buildContext();
      const reply = await generateAssistantReply(msg.text, ctx, undefined, chatId);
      await b.sendMessage(chatId, reply.message);
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // Exit only on 409 Conflict (multiple polling instances) — let PM2 restart cleanly.
  // Do NOT exit on ECONNRESET or other transient network errors; the library retries those.
  b.on("polling_error", (err: Error & { code?: string; cause?: { code?: string } }) => {
    const msg   = err.message ?? "";
    const cause = err.cause?.code ?? "";
    const is409 = msg.includes("409") || msg.toLowerCase().includes("conflict");
    if (err.code === "EFATAL" && is409) {
      console.warn("[telegram] Polling 409 Conflict — exiting for PM2 clean restart…");
      process.exit(1);
    } else {
      console.warn("[telegram] Polling error (will retry):", msg || cause || err.code);
    }
  });

  b.startPolling();
  console.log("[telegram] Bot polling started");
}

export function processWebhookUpdate(update: object): void {
  getBot().processUpdate(update as Parameters<TelegramBot["processUpdate"]>[0]);
}
