import { useEffect, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  Sparkles,
  ShieldCheck,
  Activity,
  Flame,
  Check,
  TrendingUp,
} from "lucide-react";
import {
  useGetStrategyOptions,
  useApplyStrategyOptions,
  getGetCurrentStrategyQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetPortfolioAllocationQueryKey,
  getGetStrategyOptionsQueryKey,
  type StrategyOption,
  type StrategyPick,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";

type SelectionKey = `${number}:${string}`;
const keyOf = (optionId: number, symbol: string): SelectionKey =>
  `${optionId}:${symbol}`;

const RISK_STYLES: Record<
  string,
  { icon: typeof ShieldCheck; tone: string; bar: string }
> = {
  Low: {
    icon: ShieldCheck,
    tone: "text-emerald-400 border-emerald-500/40 bg-emerald-500/10",
    bar: "from-emerald-500 to-emerald-400",
  },
  Medium: {
    icon: Activity,
    tone: "text-amber-300 border-amber-500/40 bg-amber-500/10",
    bar: "from-amber-500 to-amber-400",
  },
  High: {
    icon: Flame,
    tone: "text-rose-300 border-rose-500/40 bg-rose-500/10",
    bar: "from-rose-500 to-rose-400",
  },
};

function formatPickWeight(n: number) {
  return `${n.toFixed(1)}%`;
}

export default function StrategyOptions() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: options, isLoading } = useGetStrategyOptions();
  const apply = useApplyStrategyOptions();

  const [selected, setSelected] = useState<Set<SelectionKey>>(new Set());
  const [planName, setPlanName] = useState("Custom Mix");

  // When options change (e.g. after a regenerate), reset selection.
  useEffect(() => {
    setSelected(new Set());
  }, [options?.[0]?.generatedAt]);

  const selectedPicks = useMemo(() => {
    if (!options) return [] as Array<{ pick: StrategyPick; optionId: number }>;
    const result: Array<{ pick: StrategyPick; optionId: number }> = [];
    for (const o of options) {
      for (const p of o.picks) {
        if (selected.has(keyOf(o.id, p.symbol))) {
          result.push({ pick: p, optionId: o.id });
        }
      }
    }
    return result;
  }, [options, selected]);

  const totalSelectedWeight = selectedPicks.reduce(
    (s, x) => s + x.pick.weightPct,
    0,
  );

  const togglePick = (optionId: number, symbol: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(optionId, symbol);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const selectWholeOption = (option: StrategyOption) => {
    setSelected((prev) => {
      const next = new Set(prev);
      // Remove other options' picks for clarity (single-option mode).
      for (const k of Array.from(next)) {
        if (!k.startsWith(`${option.id}:`)) next.delete(k);
      }
      for (const p of option.picks) next.add(keyOf(option.id, p.symbol));
      return next;
    });
    setPlanName(option.name);
  };

  const clearSelection = () => setSelected(new Set());

  const handleApply = async () => {
    if (selectedPicks.length === 0) {
      toast({ title: "Pick at least one asset to apply" });
      return;
    }
    // Aggregate by symbol in case the user picked the same symbol from multiple options.
    const aggregated = new Map<string, StrategyPick>();
    for (const { pick } of selectedPicks) {
      const existing = aggregated.get(pick.symbol);
      if (existing) {
        existing.weightPct += pick.weightPct;
      } else {
        aggregated.set(pick.symbol, { ...pick });
      }
    }
    const picksPayload = Array.from(aggregated.values()).map((p) => ({
      symbol: p.symbol,
      name: p.name,
      assetClass: p.assetClass,
      weightPct: p.weightPct,
    }));

    try {
      await apply.mutateAsync({
        data: { strategyName: planName.trim() || "Custom Mix", picks: picksPayload },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetCurrentStrategyQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetPortfolioAllocationQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetStrategyOptionsQueryKey() }),
      ]);
      toast({
        title: "Strategy applied",
        description: `${picksPayload.length} picks now drive your target allocation.`,
      });
      clearSelection();
    } catch {
      toast({ title: "Could not apply strategy", variant: "destructive" });
    }
  };

  if (isLoading) {
    return (
      <Card className="p-6">
        <Skeleton className="h-72 w-full" />
      </Card>
    );
  }

  if (!options || options.length === 0) {
    return (
      <Card className="p-6 text-sm text-muted-foreground">
        <div className="flex items-center gap-2 mb-2">
          <Sparkles className="w-4 h-4 text-primary" />
          <h3 className="font-semibold text-foreground">AI Portfolio Options</h3>
        </div>
        Tap <span className="font-medium text-foreground">Regenerate</span> to
        have the AI design three portfolio paths with specific stocks and
        crypto picks tailored to your goals.
      </Card>
    );
  }

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between flex-wrap gap-3 mb-5">
        <div>
          <div className="flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">AI Portfolio Options</h3>
          </div>
          <p className="text-xs text-muted-foreground mt-1">
            Three AI-designed portfolios. Pick one whole, or check individual
            assets across all three to compose a custom mix. Weights are
            normalized to 100% on apply.
          </p>
        </div>
        {selected.size > 0 && (
          <Button variant="ghost" size="sm" onClick={clearSelection}>
            Clear selection
          </Button>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {options.map((opt) => {
          const styling = RISK_STYLES[opt.riskLevel] ?? RISK_STYLES.Medium!;
          const Icon = styling.icon;
          const allSelected = opt.picks.every((p) =>
            selected.has(keyOf(opt.id, p.symbol)),
          );

          return (
            <div
              key={opt.id}
              className="rounded-xl border border-border/60 bg-card/40 p-4 flex flex-col gap-3"
            >
              <div className="flex items-start justify-between gap-2">
                <div>
                  <h4 className="font-semibold text-sm leading-tight">
                    {opt.name}
                  </h4>
                  <Badge
                    variant="outline"
                    className={`mt-1.5 ${styling.tone} text-[10px] uppercase tracking-wide`}
                  >
                    <Icon className="w-3 h-3 mr-1" />
                    {opt.riskLevel} Risk
                  </Badge>
                </div>
                <div className="text-right">
                  <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
                    Expected
                  </p>
                  <p className="text-base font-semibold tabular-nums flex items-center justify-end gap-1">
                    <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                    {opt.expectedReturnPct.toFixed(0)}%
                  </p>
                </div>
              </div>

              <p className="text-xs text-muted-foreground leading-relaxed">
                {opt.summary}
              </p>

              <div
                className={`h-1 rounded-full bg-gradient-to-r ${styling.bar} opacity-70`}
              />

              <ul className="space-y-2 mt-1">
                {opt.picks.map((p) => {
                  const k = keyOf(opt.id, p.symbol);
                  const checked = selected.has(k);
                  return (
                    <li key={p.symbol}>
                      <label
                        className={`flex gap-3 items-start p-2 rounded-md border transition-all cursor-pointer ${
                          checked
                            ? "border-primary/60 bg-primary/5"
                            : "border-transparent hover:border-border hover:bg-muted/30"
                        }`}
                      >
                        <input
                          type="checkbox"
                          className="mt-1 accent-primary"
                          checked={checked}
                          onChange={() => togglePick(opt.id, p.symbol)}
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between gap-2">
                            <div className="flex items-baseline gap-1.5 min-w-0">
                              <span className="font-mono text-xs font-semibold">
                                {p.symbol}
                              </span>
                              <span className="text-xs text-muted-foreground truncate">
                                {p.name}
                              </span>
                            </div>
                            <span className="text-xs font-medium tabular-nums">
                              {formatPickWeight(p.weightPct)}
                            </span>
                          </div>
                          <div className="flex items-center gap-2 mt-0.5">
                            <Badge
                              variant="outline"
                              className="text-[9px] py-0 px-1.5 border-border/60 text-muted-foreground"
                            >
                              {p.assetClass}
                            </Badge>
                            <p className="text-[11px] text-muted-foreground/80 leading-snug line-clamp-2">
                              {p.rationale}
                            </p>
                          </div>
                        </div>
                      </label>
                    </li>
                  );
                })}
              </ul>

              <Button
                size="sm"
                variant={allSelected ? "default" : "outline"}
                onClick={() => selectWholeOption(opt)}
                className="mt-auto"
              >
                {allSelected ? (
                  <>
                    <Check className="w-3.5 h-3.5 mr-1" />
                    Whole option selected
                  </>
                ) : (
                  "Use entire option"
                )}
              </Button>
            </div>
          );
        })}
      </div>

      <div className="mt-6 flex flex-col md:flex-row md:items-end gap-3 pt-4 border-t border-border/60">
        <div className="flex-1 grid grid-cols-2 gap-3">
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Selected picks
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {selectedPicks.length}
            </p>
          </div>
          <div>
            <p className="text-[10px] uppercase tracking-wide text-muted-foreground">
              Combined weight (normalizes to 100%)
            </p>
            <p className="text-lg font-semibold tabular-nums">
              {totalSelectedWeight.toFixed(1)}%
            </p>
          </div>
        </div>
        <div className="md:w-56">
          <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            Strategy name
          </p>
          <Input
            value={planName}
            onChange={(e) => setPlanName(e.target.value)}
            placeholder="Custom Mix"
            className="h-9"
          />
        </div>
        <Button
          onClick={handleApply}
          disabled={apply.isPending || selectedPicks.length === 0}
          className="md:w-44"
        >
          <Sparkles className="w-4 h-4 mr-2" />
          {apply.isPending ? "Applying…" : "Apply to portfolio"}
        </Button>
      </div>
    </Card>
  );
}
