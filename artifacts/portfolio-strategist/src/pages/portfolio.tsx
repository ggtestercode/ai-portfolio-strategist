import {
  useGetPortfolio,
  useGetHoldings,
  useGetPortfolioAllocation,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { ArrowUpRight, ArrowDownRight } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import { usd, pct, pctNoSign, trendColor } from "@/lib/format";

function statusBadge(status: string) {
  if (status === "In Range")
    return "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400 border-emerald-500/20";
  if (status === "Slightly High" || status === "Slightly Low")
    return "bg-amber-500/10 text-amber-600 dark:text-amber-400 border-amber-500/20";
  return "bg-rose-500/10 text-rose-600 dark:text-rose-400 border-rose-500/20";
}

export default function Portfolio() {
  const { data: portfolio } = useGetPortfolio();
  const { data: holdings, isLoading: holdingsLoading } = useGetHoldings();
  const { data: allocation } = useGetPortfolioAllocation();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Portfolio"
        description="A complete view of every position you hold."
      />

      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">Total Value</p>
          {portfolio ? (
            <p className="text-2xl font-bold tabular-nums">{usd(portfolio.totalValue)}</p>
          ) : (
            <Skeleton className="h-8 w-32" />
          )}
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">Total P/L</p>
          {portfolio ? (
            <div>
              <p className={`text-2xl font-bold tabular-nums ${trendColor(portfolio.totalProfitLoss)}`}>
                {usd(portfolio.totalProfitLoss)}
              </p>
              <p className={`text-xs ${trendColor(portfolio.totalProfitLossPct)}`}>
                {pct(portfolio.totalProfitLossPct)}
              </p>
            </div>
          ) : (
            <Skeleton className="h-8 w-32" />
          )}
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">24h Change</p>
          {portfolio ? (
            <div>
              <p className={`text-2xl font-bold tabular-nums ${trendColor(portfolio.change24h)}`}>
                {portfolio.change24h >= 0 ? (
                  <ArrowUpRight className="w-5 h-5 inline" />
                ) : (
                  <ArrowDownRight className="w-5 h-5 inline" />
                )}
                {usd(Math.abs(portfolio.change24h))}
              </p>
              <p className={`text-xs ${trendColor(portfolio.change24hPct)}`}>
                {pct(portfolio.change24hPct)}
              </p>
            </div>
          ) : (
            <Skeleton className="h-8 w-32" />
          )}
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">Holdings</p>
          {holdings ? (
            <p className="text-2xl font-bold tabular-nums">{holdings.length}</p>
          ) : (
            <Skeleton className="h-8 w-32" />
          )}
          <p className="text-xs text-muted-foreground">
            Across {allocation?.length ?? 0} asset classes
          </p>
        </Card>
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="p-5 border-b border-border">
          <h3 className="font-semibold">Holdings</h3>
        </div>
        {holdingsLoading || !holdings ? (
          <div className="p-5 space-y-2">
            {[...Array(6)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr className="text-xs text-muted-foreground">
                  <th className="text-left px-5 py-3 font-medium">Symbol</th>
                  <th className="text-left py-3 font-medium">Name</th>
                  <th className="text-left py-3 font-medium">Class</th>
                  <th className="text-right py-3 font-medium">Quantity</th>
                  <th className="text-right py-3 font-medium">Price</th>
                  <th className="text-right py-3 font-medium">Value</th>
                  <th className="text-right px-5 py-3 font-medium">24h</th>
                </tr>
              </thead>
              <tbody>
                {holdings.map((h) => (
                  <tr
                    key={h.id}
                    className="border-t border-border/50 hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-5 py-3 font-semibold">{h.symbol}</td>
                    <td className="py-3 text-muted-foreground">{h.name}</td>
                    <td className="py-3">
                      <Badge variant="outline" className="text-xs font-normal">
                        {h.assetClass}
                      </Badge>
                    </td>
                    <td className="py-3 text-right tabular-nums">
                      {h.quantity.toLocaleString(undefined, { maximumFractionDigits: 4 })}
                    </td>
                    <td className="py-3 text-right tabular-nums">{usd(h.price)}</td>
                    <td className="py-3 text-right font-medium tabular-nums">
                      {usd(h.value)}
                    </td>
                    <td
                      className={`px-5 py-3 text-right font-medium tabular-nums ${trendColor(h.change24hPct)}`}
                    >
                      {pct(h.change24hPct)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card className="p-5">
        <h3 className="font-semibold mb-4">Allocation by Asset Class</h3>
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
                    <td className="py-3 font-medium">{row.assetClass}</td>
                    <td className="py-3 text-right tabular-nums">{pctNoSign(row.currentPct)}</td>
                    <td className="py-3 text-right text-muted-foreground tabular-nums">
                      {pctNoSign(row.targetPct)}
                    </td>
                    <td
                      className={`py-3 text-right font-medium tabular-nums ${trendColor(row.differencePct)}`}
                    >
                      {pct(row.differencePct)}
                    </td>
                    <td className="py-3 text-right">
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
    </div>
  );
}
