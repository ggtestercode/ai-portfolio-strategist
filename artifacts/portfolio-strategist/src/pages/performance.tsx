import { useState } from "react";
import {
  useGetPortfolio,
  useGetPerformanceSeries,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import PageHeader from "@/components/PageHeader";
import PerformanceChart from "@/components/charts/PerformanceChart";
import { usd, pct, trendColor } from "@/lib/format";

const RANGES = ["1D", "7D", "1M", "3M", "1Y", "ALL"] as const;
type Range = (typeof RANGES)[number];

export default function Performance() {
  const [range, setRange] = useState<Range>("3M");
  const { data: portfolio } = useGetPortfolio();
  const { data: series, isLoading } = useGetPerformanceSeries({ range });

  const stats = (() => {
    if (!series || series.points.length < 2) return null;
    const first = series.points[0]!;
    const last = series.points[series.points.length - 1]!;
    const portReturn = ((last.portfolio - first.portfolio) / first.portfolio) * 100;
    const benchReturn = ((last.benchmark - first.benchmark) / first.benchmark) * 100;
    return {
      portReturn,
      benchReturn,
      alpha: portReturn - benchReturn,
    };
  })();

  return (
    <div className="space-y-6">
      <PageHeader
        title="Performance"
        description="Long-term performance vs your benchmark, across every time horizon."
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
            <>
              <p className={`text-2xl font-bold tabular-nums ${trendColor(portfolio.totalProfitLoss)}`}>
                {usd(portfolio.totalProfitLoss)}
              </p>
              <p className={`text-xs ${trendColor(portfolio.totalProfitLossPct)}`}>
                {pct(portfolio.totalProfitLossPct)}
              </p>
            </>
          ) : (
            <Skeleton className="h-8 w-32" />
          )}
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">{range} Return</p>
          {stats ? (
            <p className={`text-2xl font-bold tabular-nums ${trendColor(stats.portReturn)}`}>
              {pct(stats.portReturn)}
            </p>
          ) : (
            <Skeleton className="h-8 w-32" />
          )}
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">{range} Alpha</p>
          {stats ? (
            <>
              <p className={`text-2xl font-bold tabular-nums ${trendColor(stats.alpha)}`}>
                {pct(stats.alpha)}
              </p>
              <p className="text-xs text-muted-foreground">
                vs benchmark {pct(stats.benchReturn)}
              </p>
            </>
          ) : (
            <Skeleton className="h-8 w-32" />
          )}
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-semibold">Portfolio vs Benchmark</h3>
          <div className="flex gap-1 text-xs">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 rounded transition-colors ${
                  range === r
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        </div>
        {isLoading || !series ? (
          <Skeleton className="h-80 w-full" />
        ) : (
          <PerformanceChart data={series.points} height={420} />
        )}
        <div className="flex items-center gap-4 mt-3 text-xs text-muted-foreground">
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-1.5 bg-primary rounded-sm" /> Portfolio
          </div>
          <div className="flex items-center gap-1.5">
            <span className="w-3 h-0.5 border-t border-dashed border-muted-foreground" /> Benchmark
          </div>
        </div>
      </Card>
    </div>
  );
}
