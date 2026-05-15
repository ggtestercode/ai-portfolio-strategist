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
import { runFreshScan, type ScanResult, getRegimeThreshold } from "../lib/marketScanner";
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
  getPositions  as bybitGetPositions,
  getBalance    as bybitGetBalance,
  getTicker     as bybitGetTicker,
  getOrders,
  getClosedPnl  as bybitGetClosedPnl,
} from "../brokers/bybit";
import { okxPaperMode } from "../lib/startup";
import {
  registerAlertNotifier,
  registerReviewNotifier,
  resolveReview,
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
  targetAllocationsTable,
  botStateTable,
  type PositionMeta,
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


async function buildContext(): Promise<AssistantContext> {
  return getCachedContext(async () => {
    const [profile, bybitPositions, allocations, config] = await Promise.all([
      db.select().from(profileTable).limit(1).then(r => r[0]),
      bybitGetPositions().catch(() => []),
      db.select().from(targetAllocationsTable),
      approvalGate.getConfig(),
    ]);
    const capital = profile?.totalCapital ?? 200;
    return {
      profile: {
        name:           profile?.name          ?? "Investor",
        riskTolerance:  (profile?.riskTolerance ?? "medium") as "low" | "medium" | "high",
        investmentGoal: `Target return: ${profile?.targetReturnPct ?? 10}% over ${profile?.timeHorizonMonths ?? 12} months`,
      },
      totalPortfolioUsd:    capital,
      availableCashUsd:     0,
      holdings:             bybitPositions.map(p => ({
        symbol:           p.symbol,
        assetClass:       "Crypto",
        currentValueUsd:  p.size * p.entryPrice / p.leverage,
        unrealisedPnlPct: p.pnlPct,
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

// Only alarm when polling has failed consecutively — transient network blips are normal.
let consecutivePollingErrors = 0;
const ERROR_ALARM_THRESHOLD  = 5; // ~25 min of sustained failure at 5-min watchdog interval

export function recordPollingSuccess(): void { consecutivePollingErrors = 0; }
export function recordPollingError():   void { consecutivePollingErrors++;   }

export async function checkBotHealth(): Promise<void> {
  if (consecutivePollingErrors >= ERROR_ALARM_THRESHOLD)
    throw new Error(`Telegram polling failing: ${consecutivePollingErrors} consecutive errors`);
}

export async function sendAlert(text: string): Promise<void> {
  await send(text, { parse_mode: "HTML" }).catch(() => {});
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
    { command: "cancelorders", description: "Cancel orders: list / 1 / all" },
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
  const alertHandler: (msg: string) => Promise<void> = async (msg) => send(msg, { parse_mode: "HTML" });
  registerAlertNotifier(alertHandler);
  registerLeverageAlert(alertHandler);
  registerWatchdogAlert(alertHandler);
  startWatchdog();

  registerReviewNotifier(async (symbol, decision, reason, pnlPctStr, reviewId) => {
    const chatId = process.env["TELEGRAM_CHAT_ID"];
    if (!chatId) return;
    await getBot().sendMessage(chatId, [
      `🔔 <b>Manual trade review — ${escapeHtml(symbol)}</b>`,
      `Claude suggests: <b>${escapeHtml(decision)}</b>`,
      `P/L: <b>${escapeHtml(pnlPctStr)}%</b>`,
      reason ? `Reason: ${escapeHtml(reason)}` : null,
      ``,
      `<i>Approve to execute · reject or 10-min timeout → HOLD</i>`,
    ].filter(Boolean).join("\n"), {
      parse_mode: "HTML",
      reply_markup: {
        inline_keyboard: [[
          { text: "✅ Execute",    callback_data: `review_approve:${reviewId}` },
          { text: "❌ Keep HOLD", callback_data: `review_reject:${reviewId}` },
        ]],
      },
    });
  });

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

    if (action !== "approve" && action !== "reject" &&
        action !== "review_approve" && action !== "review_reject") return;

    // ── Position review gate callbacks ───────────────────────────────────────
    if (action === "review_approve" || action === "review_reject") {
      const approved = action === "review_approve";
      resolveReview(proposalId, approved);
      await b.editMessageText(
        approved
          ? `✅ <b>Review approved</b> — executing now\n<i>${utcNow()}</i>`
          : `⏹ <b>Review rejected</b> — HOLD maintained\n<i>${utcNow()}</i>`,
        { chat_id: chatId, message_id: msgId, parse_mode: "HTML" },
      ).catch(() => {});
      return;
    }

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
  b.onText(/^\/mode(?:@\w+)?(?:\s+(autonomous|auto|approval))?$/, async (msg, match) => {
    const chatId  = String(msg.chat.id);
    const raw     = match?.[1];
    const newMode = (raw === "auto" ? "autonomous" : raw) as "autonomous" | "approval" | undefined;
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
      const result = await runFreshScan();

      if (!result.opportunities.length) {
        await b.sendMessage(chatId,
          `⚠️ Scan returned no results.\n<i>${utcNow()}</i>`,
          { parse_mode: "HTML" });
        return;
      }

      const regime    = result.regime;
      const threshold = getRegimeThreshold(regime?.regime);
      const regimeEmoji: Record<string, string> = {
        STRONG_TREND: "🚀", TRENDING_UP: "📈", TRENDING_DOWN: "📉",
        RANGING: "↕️", CHOPPY: "↔️", EXHAUSTION: "⚠️", VOLATILE: "⚡",
      };
      const re = regime
        ? `${regimeEmoji[regime.regime] ?? "?"} ${regime.regime} | ADX:${regime.adx.toFixed(0)}`
        : "? Unknown";

      const top5 = result.opportunities.slice(0, 5);
      const scoreLines = top5.map(o => {
        const dir   = o.direction === "short" ? "🔻" : o.direction === "long" ? "🔺" : "↔️";
        const label = o.direction === "short" ? "SHORT" : o.direction === "long" ? "LONG" : "WATCH";
        const nearTag = o.score >= threshold - 5 && o.score < threshold
          ? ` ⚠️ close (need ${threshold})`
          : "";
        return `  ${escapeHtml(o.symbol)} ${dir} ${label} — ${o.score}${nearTag}`;
      });

      // Watch: sweep/squeeze detected but below threshold
      const watched = result.opportunities
        .filter(o => o.score < threshold && (o.sweepDetected || o.squeezeDetected || o.recommendation === "WATCH"))
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
        .slice(0, 3);
      const watchLines = watched.map(o => {
        const reason = o.sweepDetected ? "sweep detected" : o.squeezeDetected ? "squeeze setup" : "setup forming";
        const adx    = regime?.adx ?? 0;
        const cond   = adx < 25 ? `enter if ADX > 25` : `confirm on 1h breakout`;
        return `  👀 ${escapeHtml(o.symbol)} — ${reason}, ${cond}`;
      });

      // Fix 1: truncate summary — split by newlines, fall back to sentences
      const shortSummary = result.summary
        .split('\n')
        .filter(line => line.trim().length > 0)
        .slice(0, 3)
        .join('\n');

      await b.sendMessage(chatId, [
        `🔍 <b>Scan complete</b> — ${re}`,
        `<i>${utcNow()}</i>`,
        ``,
        `📊 <b>Top scores</b> (need ${threshold} in ${regime?.regime ?? "?"}):`  ,
        ...scoreLines,
        watchLines.length ? `` : null,
        watchLines.length ? `👀 <b>Watch:</b>` : null,
        ...watchLines,
        ``,
        `<i>${escapeHtml(shortSummary)}</i>`,
      ].filter(l => l !== null).join("\n"), { parse_mode: "HTML" });
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

  // ── /positions — Bybit live only ─────────────────────────────────────────
  b.onText(/^\/positions(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const [[stateRow], bybitPos, localPending] = await Promise.all([
        db.select({ positionMetadata: botStateTable.positionMetadata }).from(botStateTable).limit(1).catch(() => [{ positionMetadata: {} }]),
        bybitGetPositions().catch(() => []),
        Promise.resolve(getPendingOrders()),
      ]);
      const posMeta = (stateRow?.positionMetadata ?? {}) as Record<string, PositionMeta>;

      const now = new Date().toLocaleTimeString("en-SG", {
        hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore",
      }) + " SGT";

      if (!bybitPos.length && !localPending.length) {
        await b.sendMessage(chatId,
          `📊 No open positions or pending orders.\n<i>Last synced: ${now}</i>`,
          { parse_mode: "HTML" });
        return;
      }

      const out: string[] = [`📊 <b>Positions — Bybit Live (${bybitPos.length})</b>`, ``];

      for (const p of bybitPos) {
        const sign   = p.pnl >= 0 ? "+" : "";
        const pnlStr = p.pnl !== 0 ? ` · P/L ${sign}$${p.pnl.toFixed(2)} (${sign}${p.pnlPct.toFixed(2)}%)` : "";
        const fmt    = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
        const meta   = posMeta[p.symbol];

        let stopsStr: string;
        if (meta) {
          stopsStr = [
            `\n  SL:  $${fmt(meta.sl)} (ATR×1.5)`,
            `\n  TP1: $${fmt(meta.tp1)} (ATR×1.0) → close 30%`,
            `\n  TP2: $${fmt(meta.tp2)} (ATR×2.0) → close 30% | runner: 40%`,
          ].join("");
        } else {
          const slStr = p.stopLoss   ? `\n  SL $${fmt(p.stopLoss)}`  : "";
          const tpStr = p.takeProfit ? ` · TP $${fmt(p.takeProfit)}` : "";
          stopsStr = slStr + tpStr;
        }

        const sourceTag = meta?.entrySource === "manual_nl" ? " <i>[manual]</i>"
                        : meta?.entrySource === "auto_scan"  ? " <i>[auto]</i>"
                        : "";
        out.push(`• <b>${escapeHtml(p.symbol)}</b>${sourceTag} — ${p.size} · ${p.side} · ${p.leverage}x\n  Entry $${fmt(p.entryPrice)}${pnlStr}${stopsStr}`);
      }

      if (localPending.length) {
        out.push(``, `<b>Pending approvals (${localPending.length}):</b>`);
        for (const o of localPending) {
          out.push(`• <b>${escapeHtml(o.symbol)}</b> — ${o.side.toUpperCase()} $${o.amountUsd} [${o.broker}]`);
        }
      }

      out.push(``, `<i>Last synced: ${now}</i>`);
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

  // ── /cancelorders [N|all] ────────────────────────────────────────────────
  b.onText(/^\/cancelorders(?:@\w+)?(?:\s+(.+))?$/, async (msg, match) => {
    const chatId  = String(msg.chat.id);
    const rawArg  = match?.[1]?.trim();
    const okxMode = okxPaperMode ? "Paper" : (process.env["OKX_TRADING_MODE"] === "demo" ? "Demo" : "Live");

    type OrderEntry = { kind: "okx"; orderId: string; symbol: string; side: string; price: number; size: number; placedAt: string }
                    | { kind: "local"; id: string; symbol: string; side: string; amountUsd: number };

    function fmtEntry(i: number, o: OrderEntry): string {
      if (o.kind === "okx") {
        const amt = o.price > 0 && o.size > 0 ? ` $${(o.price * o.size).toFixed(2)}` : "";
        const px  = o.price > 0 ? ` @ $${o.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "";
        const t   = new Date(o.placedAt).toLocaleTimeString("en-SG", { hour: "2-digit", minute: "2-digit", timeZone: "Asia/Singapore" }) + " SGT";
        return `${i}. ${escapeHtml(o.symbol)} ${o.side.toUpperCase()}${amt}${px} [OKX ${okxMode}] · ${t}`;
      }
      return `${i}. ${escapeHtml(o.symbol)} ${o.side.toUpperCase()} $${o.amountUsd} [local]`;
    }

    try {
      const [okxOrders, local] = await Promise.all([
        okxGetOrders().catch(() => [] as Awaited<ReturnType<typeof okxGetOrders>>),
        Promise.resolve(getPendingOrders()),
      ]);

      // Build unified numbered list
      const entries: OrderEntry[] = [
        ...okxOrders.map(o => ({ kind: "okx" as const, orderId: o.orderId, symbol: o.symbol, side: o.side, price: o.price, size: o.size, placedAt: o.placedAt })),
        ...local.map(o    => ({ kind: "local" as const, id: o.id, symbol: o.symbol, side: o.side, amountUsd: o.amountUsd })),
      ];

      // No arg — list with sequence numbers
      if (!rawArg) {
        if (!entries.length) {
          await b.sendMessage(chatId, `📋 No open orders.\n<i>${utcNow()}</i>`, { parse_mode: "HTML" });
          return;
        }
        const lines = [`📋 <b>Open orders</b> — reply <code>/cancelorders 1</code> or <code>/cancelorders all</code>`, ``];
        entries.forEach((o, i) => lines.push(fmtEntry(i + 1, o)));
        await b.sendMessage(chatId, lines.join("\n"), { parse_mode: "HTML" });
        return;
      }

      // "all" — cancel everything
      if (rawArg.toLowerCase() === "all") {
        const cancelledCount = await okxCancelAllOrders().catch(() => 0);
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

      // Sequence number
      const n = parseInt(rawArg, 10);
      if (isNaN(n) || n < 1 || n > entries.length) {
        await b.sendMessage(chatId,
          `❌ Invalid number. Use /cancelorders to see the list (1–${entries.length}).`);
        return;
      }
      const target = entries[n - 1]!;
      if (target.kind === "okx") {
        await cancelOrder(target.symbol, target.orderId);
        const amt = target.price > 0 && target.size > 0 ? ` $${(target.price * target.size).toFixed(2)}` : "";
        const px  = target.price > 0 ? ` @ $${target.price.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : "";
        await b.sendMessage(chatId,
          `✅ Cancelled — ${escapeHtml(target.symbol)} ${target.side.toUpperCase()}${amt}${px} [OKX ${okxMode}]`,
          { parse_mode: "HTML" });
      } else {
        removePendingOrder(target.id);
        await b.sendMessage(chatId,
          `✅ Cancelled — ${escapeHtml(target.symbol)} ${target.side.toUpperCase()} $${target.amountUsd} [local]`,
          { parse_mode: "HTML" });
      }
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ /cancelorders failed: ${escapeHtml(m)}`);
    }
  });

  // ── /balance — Bybit live balance ────────────────────────────────────────
  b.onText(/^\/balance(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const bal = await bybitGetBalance();
      const positions = await bybitGetPositions().catch(() => []);
      const inPositions = positions.reduce((s, p) => s + p.size * p.entryPrice, 0);

      await b.sendMessage(chatId, [
        `💰 <b>Bybit Live</b>`,
        ``,
        `Total equity: <b>$${bal.totalEquity.toFixed(2)}</b>`,
        `Available: <b>$${bal.availableBalance.toFixed(2)}</b>`,
        `In positions: <b>$${inPositions.toFixed(2)}</b> (${positions.length} open)`,
        ``,
        `<i>${utcNow()}</i>`,
      ].join("\n"), { parse_mode: "HTML" });
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

  // ── /status — Bybit live status ──────────────────────────────────────────
  b.onText(/^\/status(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const [config, cron, dailyPnl, bybitBal, bybitPos, localPending] =
        await Promise.all([
          approvalGate.getConfig(),
          Promise.resolve(getCronStatus()),
          getDailyPnl().catch(() => 0),
          bybitGetBalance().catch(() => null),
          bybitGetPositions().catch(() => []),
          Promise.resolve(getPendingOrders()),
        ]);

      const pnlSign    = dailyPnl >= 0 ? "+" : "";
      const dailyLimit = process.env["DAILY_LOSS_LIMIT_PCT"] ?? "30";
      const maxTrade   = process.env["MAX_AUTO_TRADE_USD"] ?? "5";
      const lastScan   = cron.lastScan
        ? cron.lastScan.toLocaleString("en-SG", { timeZone: "Asia/Singapore", hour12: false }) + " SGT"
        : "Never";
      const nextScanNote = cron.enabled && cron.interval !== "disabled"
        ? `Schedule: <code>${escapeHtml(cron.interval)}</code>`
        : `Auto-scanner: ⏸ Off`;

      await b.sendMessage(chatId, [
        `🤖 <b>Bot Status</b>`,
        ``,
        `Mode: <b>${config.mode}</b>`,
        `Trading: <b>${cron.paused ? "🛑 Paused" : "▶️ Active"}</b>`,
        ``,
        `💼 <b>Bybit Live</b>`,
        bybitBal ? `Balance: <b>$${bybitBal.totalEquity.toFixed(2)}</b>` : `Balance: ❌ unavailable`,
        `Open positions: <b>${bybitPos.length}</b>`,
        `Daily P/L: <b>${pnlSign}$${dailyPnl.toFixed(2)}</b>`,
        localPending.length ? `Pending approvals: <b>${localPending.length}</b>` : "",
        ``,
        `⚙️ <b>Settings</b>`,
        `Leverage: <b>10x</b>`,
        `Per trade: <b>$${maxTrade} margin ($${parseInt(maxTrade) * 10} notional)</b>`,
        `Daily loss limit: <b>-${dailyLimit}%</b>`,
        nextScanNote,
        `Last scan: ${lastScan}`,
      ].filter(Boolean).join("\n"), { parse_mode: "HTML" });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      await b.sendMessage(chatId, `❌ ${escapeHtml(m)}`).catch(() => {});
    }
  });

  // ── /history — live Bybit open positions + closed PnL ───────────────────
  b.onText(/^\/history(?:@\w+)?$/, async (msg) => {
    const chatId = String(msg.chat.id);
    try {
      const [openPositions, closedPnl] = await Promise.all([
        bybitGetPositions(),
        bybitGetClosedPnl(20),
      ]);

      if (!openPositions.length && !closedPnl.length) {
        await b.sendMessage(chatId,
          `📋 No Bybit trades found.\n<i>${utcNow()}</i>`,
          { parse_mode: "HTML" });
        return;
      }

      // Manual UTC+8 formatter — avoids toLocaleString "24:xx" midnight bug in Node
      const fmtSGT = (ms: number) => {
        const d  = new Date(ms + 8 * 3_600_000); // shift to SGT (UTC+8)
        const p  = (n: number) => String(n).padStart(2, "0");
        return `${p(d.getUTCDate())}/${p(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}, ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())} SGT`;
      };

      const out: string[] = [`📋 <b>Trade History (Bybit)</b>`, ``];

      if (openPositions.length) {
        out.push(`<b>Open (${openPositions.length}):</b>`);
        for (const p of openPositions) {
          const dir    = p.side === "Buy" ? "▲ long" : "▼ short";
          const pnlSign = p.pnl >= 0 ? "+" : "";
          const sl     = p.stopLoss  ? ` SL:$${p.stopLoss.toLocaleString("en-US",  { maximumFractionDigits: 4 })}` : "";
          const tp     = p.takeProfit ? ` TP:$${p.takeProfit.toLocaleString("en-US", { maximumFractionDigits: 4 })}` : "";
          const when   = p.openTime > 0 ? ` · ${fmtSGT(p.openTime)}` : "";
          out.push(`• <b>${escapeHtml(p.symbol)}</b> ${dir} · entry $${p.entryPrice.toLocaleString("en-US", { maximumFractionDigits: 4 })} · ${p.leverage}x · PnL: ${pnlSign}$${p.pnl.toFixed(2)} (${pnlSign}${p.pnlPct.toFixed(1)}%)${sl}${tp}${when}`);
        }
        out.push(``);
      }

      if (closedPnl.length) {
        type ClosedRec = typeof closedPnl[number];

        // Group by symbol+side+avgEntryPrice (= same original position), sort each group chron
        const groupMap = new Map<string, ClosedRec[]>();
        for (const p of [...closedPnl].sort((a, b) => a.closedAt - b.closedAt)) {
          const key = `${p.symbol}|${p.side}|${p.avgEntryPrice}`;
          const g   = groupMap.get(key) ?? [];
          g.push(p);
          groupMap.set(key, g);
        }

        interface TradeSummary {
          symbol: string; side: "Buy"|"Sell"; entryPrice: number;
          closes: ClosedRec[]; totalPnl: number;
          bestExit: number; finalExit: number;
          firstCloseAt: number; lastCloseAt: number;
        }

        const trades: TradeSummary[] = [...groupMap.values()].map(closes => {
          const side     = closes[0]!.side;
          const totalPnl = closes.reduce((s, c) => s + c.closedPnl, 0);
          const bestExit = side === "Buy"
            ? Math.max(...closes.map(c => c.avgExitPrice))
            : Math.min(...closes.map(c => c.avgExitPrice));
          return {
            symbol: closes[0]!.symbol, side, entryPrice: closes[0]!.avgEntryPrice,
            closes, totalPnl, bestExit,
            finalExit:    closes[closes.length - 1]!.avgExitPrice,
            firstCloseAt: closes[0]!.closedAt,
            lastCloseAt:  closes[closes.length - 1]!.closedAt,
          };
        }).sort((a, b) => b.lastCloseAt - a.lastCloseAt); // newest first

        const fmtPrice = (n: number) => n.toLocaleString("en-US", { maximumFractionDigits: 4 });
        const fmtDur   = (ms: number) => {
          if (ms < 60_000)         return `<1min`;
          if (ms < 3_600_000)      return `~${Math.round(ms / 60_000)}min`;
          if (ms < 86_400_000)     return `~${(ms / 3_600_000).toFixed(1)}h`;
          return `~${(ms / 86_400_000).toFixed(1)}d`;
        };

        out.push(`<b>Trades (${trades.length} positions, ${closedPnl.length} closes):</b>`);
        trades.forEach((t, i) => {
          const dir      = t.side === "Buy" ? "▲" : "▼";
          const label    = t.side === "Buy" ? "LONG" : "SHORT";
          const sign     = t.totalPnl >= 0 ? "+" : "";
          const nPartial = t.closes.length - 1;
          const closeLbl = t.closes.length === 1
            ? "Full close"
            : `${t.closes.length} closes (${nPartial} partial + 1 full)`;
          const durMs    = t.lastCloseAt - t.firstCloseAt;

          out.push(`${i + 1}. <b>${escapeHtml(t.symbol)}</b> ${dir} ${label} — Total: <b>${sign}$${t.totalPnl.toFixed(2)}</b>`);
          out.push(`   Entry: $${fmtPrice(t.entryPrice)} | ${closeLbl}`);
          if (t.closes.length > 1) {
            out.push(`   Best exit: $${fmtPrice(t.bestExit)} | Final exit: $${fmtPrice(t.finalExit)}`);
            if (durMs > 60_000) out.push(`   Duration: ${fmtDur(durMs)}`);
          } else {
            out.push(`   Exit: $${fmtPrice(t.finalExit)} | ${fmtSGT(t.lastCloseAt)}`);
          }
          out.push(``);
        });

        // ── Summary ────────────────────────────────────────────────────────────
        const winners  = trades.filter(t => t.totalPnl > 0);
        const losers   = trades.filter(t => t.totalPnl <= 0);
        const totalPnl = trades.reduce((s, t) => s + t.totalPnl, 0);
        const avgWin   = winners.length ? winners.reduce((s, t) => s + t.totalPnl, 0) / winners.length : 0;
        const avgLoss  = losers.length  ? Math.abs(losers.reduce((s, t) => s + t.totalPnl, 0) / losers.length) : 0;
        const winPct   = Math.round(winners.length / trades.length * 100);
        const totalSign = totalPnl >= 0 ? "+" : "";

        out.push(`📊 <b>Summary (${trades.length} trades)</b>`);
        out.push(`✅ Winners: ${winners.length} (${winPct}%)`);
        out.push(`❌ Losers: ${losers.length} (${100 - winPct}%)`);
        out.push(`💰 Total P/L: ${totalSign}$${totalPnl.toFixed(2)}`);
        if (avgWin  > 0) out.push(`📈 Avg win: +$${avgWin.toFixed(2)}`);
        if (avgLoss > 0) out.push(`📉 Avg loss: -$${avgLoss.toFixed(2)}`);
        if (avgWin > 0 && avgLoss > 0) {
          const rr      = avgLoss / avgWin;
          const rrLabel = rr > 2 ? " (needs improvement)" : " (good)";
          out.push(`⚖️ R:R ratio: 1:${rr.toFixed(1)}${rrLabel}`);
        }
        out.push(``);
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
  // Catch any raw 'error' event from the underlying transport — unhandled 'error' events crash Node
  b.on("error", (err: Error) => {
    console.warn("[telegram] Bot error (suppressed):", err.message);
  });

  b.on("polling_error", (err: Error & { code?: string; cause?: { code?: string } }) => {
    const msg   = err.message ?? "";
    const cause = err.cause?.code ?? "";
    const is409 = msg.includes("409") || msg.toLowerCase().includes("conflict");
    if (is409) {
      recordPollingError();
      console.warn(`[telegram] 409 Conflict (consecutive=${consecutivePollingErrors}): another bot instance is polling — check for remote deployments`);
    } else {
      recordPollingError();
      console.warn(`[telegram] Polling error (will retry, consecutive=${consecutivePollingErrors}):`, msg || cause || err.code);
    }
  });

  b.on("message",        () => { recordPollingSuccess(); });
  b.on("callback_query", () => { recordPollingSuccess(); });

  b.startPolling();
  console.log("[telegram] Bot polling started");
}

export function processWebhookUpdate(update: object): void {
  getBot().processUpdate(update as Parameters<TelegramBot["processUpdate"]>[0]);
}
