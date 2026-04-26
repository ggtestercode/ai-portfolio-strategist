import { useMemo, useState } from "react";
import { useGetPerformanceSeries } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { LineChart as LineIcon, TrendingUp, TrendingDown, Activity, Award } from "lucide-react";
import PageHeader from "@/components/PageHeader";
import PerformanceChart from "@/components/charts/PerformanceChart";
import { pct, trendColor } from "@/lib/format";

const RANGES = ["1M", "3M", "1Y", "ALL"] as const;
type Range = (typeof RANGES)[number];

function computeStats(points: { portfolio: number; benchmark: number }[]) {
  if (points.length < 2) return null;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const portReturn = ((last.portfolio - first.portfolio) / first.portfolio) * 100;
  const benchReturn = ((last.benchmark - first.benchmark) / first.benchmark) * 100;

  let peak = first.portfolio;
  let maxDrawdown = 0;
  for (const p of points) {
    if (p.portfolio > peak) peak = p.portfolio;
    const dd = ((peak - p.portfolio) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const dailyReturns: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!.portfolio;
    const curr = points[i]!.portfolio;
    dailyReturns.push((curr - prev) / prev);
  }
  const mean =
    dailyReturns.reduce((s, x) => s + x, 0) / Math.max(1, dailyReturns.length);
  const variance =
    dailyReturns.reduce((s, x) => s + (x - mean) ** 2, 0) /
    Math.max(1, dailyReturns.length);
  const volatility = Math.sqrt(variance) * 100;

  const sharpe = volatility > 0 ? (mean / Math.sqrt(variance)) * Math.sqrt(252) : 0;

  return {
    portReturn,
    benchReturn,
    alpha: portReturn - benchReturn,
    maxDrawdown,
    volatility,
    sharpe,
  };
}

export default function Backtesting() {
  const [range, setRange] = useState<Range>("3M");
  const { data: series, isLoading } = useGetPerformanceSeries({ range });

  const stats = useMemo(
    () => (series ? computeStats(series.points) : null),
    [series],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        title="Backtesting"
        description="See how your strategy would have performed across different time horizons against a benchmark."
        action={
          <div className="flex gap-1 text-xs">
            {RANGES.map((r) => (
              <button
                key={r}
                onClick={() => setRange(r)}
                className={`px-3 py-1.5 rounded transition-colors ${
                  range === r
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground bg-muted hover:bg-muted/70"
                }`}
              >
                {r}
              </button>
            ))}
          </div>
        }
      />

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <TrendingUp className="w-3 h-3" /> Portfolio Return
          </div>
          {stats ? (
            <p className={`text-2xl font-bold tabular-nums ${trendColor(stats.portReturn)}`}>
              {pct(stats.portReturn)}
            </p>
          ) : (
            <Skeleton className="h-8 w-20" />
          )}
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <Activity className="w-3 h-3" /> Benchmark Return
          </div>
          {stats ? (
            <p className={`text-2xl font-bold tabular-nums ${trendColor(stats.benchReturn)}`}>
              {pct(stats.benchReturn)}
            </p>
          ) : (
            <Skeleton className="h-8 w-20" />
          )}
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <Award className="w-3 h-3" /> Alpha
          </div>
          {stats ? (
            <p className={`text-2xl font-bold tabular-nums ${trendColor(stats.alpha)}`}>
              {pct(stats.alpha)}
            </p>
          ) : (
            <Skeleton className="h-8 w-20" />
          )}
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <TrendingDown className="w-3 h-3" /> Max Drawdown
          </div>
          {stats ? (
            <p className="text-2xl font-bold tabular-nums text-rose-500">
              -{stats.maxDrawdown.toFixed(1)}%
            </p>
          ) : (
            <Skeleton className="h-8 w-20" />
          )}
        </Card>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">Volatility (per period)</p>
          {stats ? (
            <p className="text-xl font-semibold tabular-nums">
              {stats.volatility.toFixed(2)}%
            </p>
          ) : (
            <Skeleton className="h-7 w-20" />
          )}
          <p className="text-xs text-muted-foreground mt-1">
            Std dev of daily returns
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">Sharpe-like Ratio</p>
          {stats ? (
            <p className="text-xl font-semibold tabular-nums">
              {stats.sharpe.toFixed(2)}
            </p>
          ) : (
            <Skeleton className="h-7 w-20" />
          )}
          <p className="text-xs text-muted-foreground mt-1">
            Risk-adjusted performance
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">Beat Benchmark</p>
          {stats ? (
            <p
              className={`text-xl font-semibold ${stats.alpha >= 0 ? "text-emerald-500" : "text-rose-500"}`}
            >
              {stats.alpha >= 0 ? "Yes" : "No"}
            </p>
          ) : (
            <Skeleton className="h-7 w-20" />
          )}
          <p className="text-xs text-muted-foreground mt-1">Over selected window</p>
        </Card>
      </div>

      <Card className="p-5">
        <div className="flex items-center gap-2 mb-4">
          <LineIcon className="w-4 h-4 text-primary" />
          <h3 className="font-semibold">Equity Curve vs Benchmark</h3>
        </div>
        {isLoading || !series ? (
          <Skeleton className="h-80 w-full" />
        ) : (
          <PerformanceChart data={series.points} height={380} />
        )}
      </Card>
    </div>
  );
}
