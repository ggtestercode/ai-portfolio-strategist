import { useState } from "react";
import { Link } from "wouter";
import { useQueryClient } from "@tanstack/react-query";
import { motion } from "framer-motion";
import {
  Target,
  Sparkles,
  MessageSquare,
  ArrowUpRight,
  ArrowDownRight,
  TrendingUp,
  AlertTriangle,
  Repeat,
  Pencil,
  Send,
  ShieldAlert,
  Info,
  CircleAlert,
} from "lucide-react";
import {
  useGetDashboardSummary,
  useGetPortfolio,
  useGetPortfolioAllocation,
  useGetPerformanceSeries,
  useGetRebalancingSuggestions,
  useApplyRebalancing,
  getGetRebalancingSuggestionsQueryKey,
  getGetPortfolioQueryKey,
  getGetPortfolioAllocationQueryKey,
  getGetDashboardSummaryQueryKey,
  useListAlerts,
  useGetLastTradeSuggestion,
  useListAssistantMessages,
  useSendAssistantMessage,
  getListAssistantMessagesQueryKey,
  useRegenerateStrategy,
  getGetCurrentStrategyQueryKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import AICommandCenter from "@/components/AICommandCenter";
import AllocationDonut from "@/components/charts/AllocationDonut";
import PerformanceChart from "@/components/charts/PerformanceChart";
import { usd, usdShort, pct, pctNoSign, trendColor } from "@/lib/format";

const RANGES = ["1D", "7D", "1M", "3M", "1Y", "ALL"] as const;
type Range = (typeof RANGES)[number];

const QUICK_ACTIONS = [
  {
    title: "Define Investment Goals",
    description: "Set capital, return targets, and risk tolerance.",
    icon: Target,
    href: "/goals",
    accent: "from-blue-500/20 to-blue-500/5",
  },
  {
    title: "Generate Strategy",
    description: "Let AI design your personalized allocation.",
    icon: Sparkles,
    href: "/goals",
    accent: "from-emerald-500/20 to-emerald-500/5",
    action: "regenerate",
  },
  {
    title: "Get AI Trade Advice",
    description: "Real-time guidance from your AI co-pilot.",
    icon: MessageSquare,
    href: "/trade-assistant",
    accent: "from-violet-500/20 to-violet-500/5",
  },
];

function statusBadge(status: string) {
  if (status === "In Range")
    return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
  if (status === "Slightly High" || status === "Slightly Low")
    return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20";
  return "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20";
}

function severityIcon(sev: string) {
  if (sev === "Critical") return ShieldAlert;
  if (sev === "Warning") return AlertTriangle;
  return Info;
}

function severityColor(sev: string) {
  if (sev === "Critical") return "text-rose-500";
  if (sev === "Warning") return "text-amber-500";
  return "text-blue-400";
}

export default function Dashboard() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [range, setRange] = useState<Range>("1M");
  const [chatInput, setChatInput] = useState("");

  const { data: summary, isLoading: summaryLoading } = useGetDashboardSummary();
  const { data: portfolio } = useGetPortfolio();
  const { data: allocation } = useGetPortfolioAllocation();
  const { data: performance, isLoading: perfLoading } =
    useGetPerformanceSeries({ range });
  const { data: rebalActions } = useGetRebalancingSuggestions();
  const { data: alerts } = useListAlerts();
  const { data: lastTrade } = useGetLastTradeSuggestion();
  const { data: assistantMessages } = useListAssistantMessages();

  const applyRebal = useApplyRebalancing();
  const regenerate = useRegenerateStrategy();
  const sendMessage = useSendAssistantMessage();

  const activeAlerts = (alerts ?? []).filter((a) => !a.dismissed).slice(0, 3);
  const recentMessages = (assistantMessages ?? []).slice(-2);
  const rebalCount = (rebalActions ?? []).length;

  const handleRegen = async () => {
    try {
      await regenerate.mutateAsync();
      await queryClient.invalidateQueries({
        queryKey: getGetCurrentStrategyQueryKey(),
      });
      await queryClient.invalidateQueries({
        queryKey: getGetDashboardSummaryQueryKey(),
      });
      toast({ title: "Strategy regenerated", description: "Your AI strategy has been refreshed." });
    } catch {
      toast({ title: "Could not regenerate", variant: "destructive" });
    }
  };

  const handleApplyRebal = async () => {
    try {
      const res = await applyRebal.mutateAsync();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetRebalancingSuggestionsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetPortfolioQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetPortfolioAllocationQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }),
      ]);
      toast({
        title: "Rebalancing applied",
        description: `${res.appliedCount} action${res.appliedCount === 1 ? "" : "s"} executed.`,
      });
    } catch {
      toast({ title: "Could not apply rebalancing", variant: "destructive" });
    }
  };

  const handleSendChat = async (text: string) => {
    const msg = text.trim();
    if (!msg) return;
    try {
      await sendMessage.mutateAsync({ data: { content: msg } });
      await queryClient.invalidateQueries({
        queryKey: getListAssistantMessagesQueryKey(),
      });
      setChatInput("");
    } catch {
      toast({ title: "Message failed", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <motion.div
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.3 }}
      >
        <h2 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-3">
          What would you like to do?
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          {QUICK_ACTIONS.map((a, i) => {
            const Icon = a.icon;
            const content = (
              <Card
                className={`relative overflow-hidden p-5 h-full bg-gradient-to-br ${a.accent} hover:border-primary/40 transition-all cursor-pointer hover-elevate`}
              >
                <div className="flex items-start gap-3 mb-3">
                  <div className="w-9 h-9 rounded-lg bg-background/40 backdrop-blur flex items-center justify-center text-foreground">
                    <Icon className="w-4 h-4" />
                  </div>
                </div>
                <h3 className="font-semibold mb-1">{a.title}</h3>
                <p className="text-xs text-muted-foreground">{a.description}</p>
                <ArrowUpRight className="w-4 h-4 absolute top-4 right-4 text-muted-foreground" />
              </Card>
            );
            return (
              <motion.div
                key={a.title}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.05 }}
              >
                {a.action === "regenerate" ? (
                  <button
                    onClick={handleRegen}
                    className="w-full text-left h-full"
                    disabled={regenerate.isPending}
                  >
                    {content}
                  </button>
                ) : (
                  <Link href={a.href}>{content}</Link>
                )}
              </motion.div>
            );
          })}
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.15 }}
          >
            <AICommandCenter />
          </motion.div>
        </div>
      </motion.div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Target className="w-4 h-4 text-primary" />
              Investment Goals
            </h3>
            <Link
              href="/goals"
              className="text-xs text-primary hover:underline flex items-center gap-1"
            >
              <Pencil className="w-3 h-3" /> Edit
            </Link>
          </div>
          {summaryLoading || !summary ? (
            <div className="space-y-2">
              <Skeleton className="h-6 w-full" />
              <Skeleton className="h-6 w-3/4" />
            </div>
          ) : (
            <div className="space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <p className="text-xs text-muted-foreground">Total Capital</p>
                  <p className="font-semibold">{usd(summary.goals.totalCapital)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Target Return</p>
                  <p className="font-semibold">{summary.goals.targetReturnPct}%</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Time Horizon</p>
                  <p className="font-semibold">{summary.goals.timeHorizonMonths} mo</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Risk</p>
                  <p className="font-semibold">{summary.goals.riskTolerance}</p>
                </div>
              </div>
              <div>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-muted-foreground">Goal Progress</span>
                  <span className="font-medium">{summary.goals.goalProgressPct}%</span>
                </div>
                <div className="h-2 rounded-full bg-muted overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-primary to-emerald-500 transition-all duration-700"
                    style={{ width: `${summary.goals.goalProgressPct}%` }}
                  />
                </div>
                {summary.goals.goalProgressNote && (
                  <p className="text-xs text-muted-foreground mt-2">
                    {summary.goals.goalProgressNote}
                  </p>
                )}
              </div>
            </div>
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              Current Strategy
            </h3>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleRegen}
              disabled={regenerate.isPending}
              className="h-7 text-xs"
            >
              <Repeat className="w-3 h-3 mr-1" />
              Regenerate
            </Button>
          </div>
          {summary ? (
            <div className="space-y-3">
              <div className="flex items-center gap-3">
                <div className="flex-shrink-0">
                  <AllocationDonut allocation={summary.strategy.allocation} size={120} />
                </div>
                <div className="flex-1 min-w-0 space-y-1.5">
                  <div>
                    <p className="text-xs text-muted-foreground">Strategy</p>
                    <p className="font-semibold text-sm">{summary.strategy.strategyType}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Risk Level</p>
                    <p className="font-medium text-sm">{summary.strategy.riskLevel}</p>
                  </div>
                </div>
              </div>
              <div className="border-t border-border pt-3">
                <p className="text-xs text-muted-foreground mb-1">Key Rules</p>
                <ul className="text-xs space-y-0.5">
                  {summary.strategy.keyRules.slice(0, 3).map((r) => (
                    <li key={r} className="flex gap-1.5">
                      <span className="text-primary">•</span> <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
              <Link
                href="/goals"
                className="text-xs text-primary hover:underline block"
              >
                View Full Strategy →
              </Link>
            </div>
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold flex items-center gap-2">
              <TrendingUp className="w-4 h-4 text-primary" />
              Portfolio Overview
            </h3>
            <Link href="/performance" className="text-xs text-primary hover:underline">
              Details →
            </Link>
          </div>
          {portfolio ? (
            <div className="space-y-3">
              <div>
                <p className="text-3xl font-bold tracking-tight">
                  {usd(portfolio.totalValue)}
                </p>
                <div className="flex items-center gap-2 text-sm mt-1">
                  <span className={trendColor(portfolio.totalProfitLoss)}>
                    {portfolio.totalProfitLoss >= 0 ? (
                      <ArrowUpRight className="w-3 h-3 inline" />
                    ) : (
                      <ArrowDownRight className="w-3 h-3 inline" />
                    )}
                    {usd(Math.abs(portfolio.totalProfitLoss))} ({pct(portfolio.totalProfitLossPct)})
                  </span>
                  <span className="text-muted-foreground text-xs">All-time</span>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  24h:{" "}
                  <span className={trendColor(portfolio.change24h)}>
                    {usd(portfolio.change24h)} ({pct(portfolio.change24hPct)})
                  </span>
                </p>
              </div>
              <div className="flex gap-1 text-xs">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    onClick={() => setRange(r)}
                    className={`px-2 py-1 rounded transition-colors ${
                      range === r
                        ? "bg-primary text-primary-foreground"
                        : "text-muted-foreground hover:bg-muted"
                    }`}
                  >
                    {r}
                  </button>
                ))}
              </div>
              <div className="-mx-2">
                {perfLoading || !performance ? (
                  <Skeleton className="h-32 w-full" />
                ) : (
                  <PerformanceChart data={performance.points} height={140} />
                )}
              </div>
            </div>
          ) : (
            <Skeleton className="h-48 w-full" />
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-4">
            <h3 className="font-semibold">Portfolio Allocation</h3>
            <Link href="/portfolio" className="text-xs text-primary hover:underline">
              View All →
            </Link>
          </div>
          {allocation ? (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground border-b border-border">
                    <th className="text-left py-2 font-medium">Asset Class</th>
                    <th className="text-right py-2 font-medium">Current</th>
                    <th className="text-right py-2 font-medium">Target</th>
                    <th className="text-right py-2 font-medium">Diff</th>
                    <th className="text-right py-2 font-medium">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {allocation.map((row) => (
                    <tr key={row.assetClass} className="border-b border-border/50 last:border-0">
                      <td className="py-2.5 font-medium">{row.assetClass}</td>
                      <td className="py-2.5 text-right tabular-nums">
                        {pctNoSign(row.currentPct)}
                      </td>
                      <td className="py-2.5 text-right text-muted-foreground tabular-nums">
                        {pctNoSign(row.targetPct)}
                      </td>
                      <td
                        className={`py-2.5 text-right tabular-nums font-medium ${trendColor(row.differencePct)}`}
                      >
                        {pct(row.differencePct)}
                      </td>
                      <td className="py-2.5 text-right">
                        <Badge
                          variant="outline"
                          className={`${statusBadge(row.status)} text-xs`}
                        >
                          {row.status}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Skeleton className="h-40 w-full" />
          )}
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold flex items-center gap-2">
              <Repeat className="w-4 h-4 text-primary" />
              Rebalancing
              {rebalCount > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 text-xs">
                  {rebalCount}
                </Badge>
              )}
            </h3>
          </div>
          {rebalActions && rebalActions.length > 0 ? (
            <div className="space-y-2">
              {rebalActions.slice(0, 4).map((a) => (
                <div
                  key={a.id}
                  className="flex items-center justify-between text-sm py-1.5 border-b border-border/50 last:border-0"
                >
                  <div className="flex items-center gap-2">
                    <Badge
                      variant="outline"
                      className={
                        a.actionType === "Buy"
                          ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20 text-xs"
                          : "bg-rose-500/10 text-rose-500 border-rose-500/20 text-xs"
                      }
                    >
                      {a.actionType}
                    </Badge>
                    <span>{a.asset}</span>
                  </div>
                  <span className="font-medium tabular-nums">{usdShort(a.amount)}</span>
                </div>
              ))}
              <Button
                onClick={handleApplyRebal}
                disabled={applyRebal.isPending}
                size="sm"
                className="w-full mt-2"
              >
                {applyRebal.isPending ? "Applying…" : "Apply Suggestions"}
              </Button>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground py-6 text-center">
              Allocation is on target.
            </p>
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <Card className="p-5 lg:col-span-2">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold flex items-center gap-2">
              <MessageSquare className="w-4 h-4 text-primary" />
              AI Trade Assistant
            </h3>
            <Link
              href="/trade-assistant"
              className="text-xs text-primary hover:underline"
            >
              Open Chat →
            </Link>
          </div>
          <div className="space-y-2 mb-3 min-h-[120px]">
            {recentMessages.length === 0 ? (
              <p className="text-sm text-muted-foreground py-6 text-center">
                Ask anything about your portfolio.
              </p>
            ) : (
              recentMessages.map((m) => (
                <div
                  key={m.id}
                  className={`p-3 rounded-lg text-sm ${
                    m.role === "user"
                      ? "bg-primary/10 ml-8 text-foreground"
                      : "bg-muted mr-8"
                  }`}
                >
                  {m.content}
                </div>
              ))
            )}
          </div>
          <button
            type="button"
            onClick={() => handleSendChat("Should I buy more ETH now?")}
            className="text-xs bg-muted hover:bg-muted/70 text-muted-foreground px-3 py-1.5 rounded-full mb-2 inline-block"
          >
            Should I buy more ETH now?
          </button>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleSendChat(chatInput);
            }}
            className="relative"
          >
            <input
              type="text"
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              placeholder="Ask your AI co-pilot…"
              disabled={sendMessage.isPending}
              className="w-full bg-background border border-input rounded-lg pl-3 pr-10 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              disabled={!chatInput.trim() || sendMessage.isPending}
              className="absolute right-1 top-1/2 -translate-y-1/2 h-8 w-8"
            >
              <Send className="w-4 h-4" />
            </Button>
          </form>
        </Card>

        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-primary" />
              Risk Alerts
              {activeAlerts.length > 0 && (
                <Badge variant="secondary" className="ml-1 h-5 text-xs">
                  {activeAlerts.length}
                </Badge>
              )}
            </h3>
            <Link href="/alerts" className="text-xs text-primary hover:underline">
              All →
            </Link>
          </div>
          {activeAlerts.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No active alerts.
            </p>
          ) : (
            <div className="space-y-3">
              {activeAlerts.map((a) => {
                const Icon = severityIcon(a.severity);
                return (
                  <div key={a.id} className="flex gap-2">
                    <Icon
                      className={`w-4 h-4 mt-0.5 flex-shrink-0 ${severityColor(a.severity)}`}
                    />
                    <div className="text-xs">
                      <p className="font-medium">{a.title}</p>
                      <p className="text-muted-foreground">{a.message}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </Card>
      </div>

      {lastTrade && (
        <Card className="p-5">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-semibold flex items-center gap-2">
              <CircleAlert className="w-4 h-4 text-primary" />
              Last Trade Suggestion
            </h3>
            <Link
              href="/trade-assistant"
              className="text-xs text-primary hover:underline"
            >
              Trade Center →
            </Link>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-5 gap-4 items-center">
            <div className="md:col-span-2">
              <div className="flex items-center gap-2 mb-1">
                <Badge
                  variant="outline"
                  className={
                    lastTrade.side === "Buy"
                      ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                      : lastTrade.side === "Sell"
                        ? "bg-rose-500/10 text-rose-500 border-rose-500/20"
                        : "bg-amber-500/10 text-amber-500 border-amber-500/20"
                  }
                >
                  {lastTrade.side}
                </Badge>
                <span className="font-semibold">{lastTrade.pair}</span>
              </div>
              <p className="text-sm text-muted-foreground">{lastTrade.summary}</p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Entry</p>
              <p className="text-sm font-medium tabular-nums">
                {usd(lastTrade.entryRangeLow)}–{usd(lastTrade.entryRangeHigh)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Target</p>
              <p className="text-sm font-medium text-emerald-500 tabular-nums">
                {usd(lastTrade.target)}
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground">Stop Loss</p>
              <p className="text-sm font-medium text-rose-500 tabular-nums">
                {usd(lastTrade.stopLoss)}
              </p>
            </div>
          </div>
          {lastTrade.riskWarning && (
            <p className="text-xs text-amber-500 mt-3 flex items-center gap-1">
              <AlertTriangle className="w-3 h-3" /> {lastTrade.riskWarning}
            </p>
          )}
        </Card>
      )}
    </div>
  );
}
