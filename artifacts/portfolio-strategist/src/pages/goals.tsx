import { useEffect, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Sparkles, Repeat, Target, Save } from "lucide-react";
import {
  useGetInvestmentGoals,
  useUpdateInvestmentGoals,
  useGetCurrentStrategy,
  useRegenerateStrategy,
  getGetInvestmentGoalsQueryKey,
  getGetDashboardSummaryQueryKey,
  getGetCurrentStrategyQueryKey,
  getGetStrategyOptionsQueryKey,
  getGetPortfolioAllocationQueryKey,
} from "@workspace/api-client-react";
import StrategyOptions from "@/components/StrategyOptions";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import PageHeader from "@/components/PageHeader";
import AllocationDonut from "@/components/charts/AllocationDonut";
import { usd } from "@/lib/format";

const RISKS = ["Low", "Medium", "High"] as const;

export default function Goals() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: goals, isLoading: goalsLoading } = useGetInvestmentGoals();
  const { data: strategy, isLoading: strategyLoading } = useGetCurrentStrategy();
  const updateGoals = useUpdateInvestmentGoals();
  const regenerate = useRegenerateStrategy();

  const [totalCapital, setTotalCapital] = useState(50000);
  const [targetReturnPct, setTargetReturnPct] = useState(15);
  const [timeHorizonMonths, setTimeHorizonMonths] = useState(24);
  const [riskTolerance, setRiskTolerance] = useState<(typeof RISKS)[number]>("Medium");

  useEffect(() => {
    if (goals) {
      setTotalCapital(goals.totalCapital);
      setTargetReturnPct(goals.targetReturnPct);
      setTimeHorizonMonths(goals.timeHorizonMonths);
      setRiskTolerance(goals.riskTolerance as (typeof RISKS)[number]);
    }
  }, [goals]);

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updateGoals.mutateAsync({
        data: {
          totalCapital,
          targetReturnPct,
          timeHorizonMonths,
          riskTolerance,
        },
      });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetInvestmentGoalsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }),
      ]);
      toast({ title: "Goals updated", description: "Your investment goals are saved." });
    } catch {
      toast({ title: "Failed to save", variant: "destructive" });
    }
  };

  const handleRegen = async () => {
    try {
      const result = await regenerate.mutateAsync();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetCurrentStrategyQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetStrategyOptionsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetPortfolioAllocationQueryKey() }),
      ]);
      toast({
        title: "Strategy regenerated",
        description: `AI produced ${result.options.length} portfolio options below — select picks to mix and match.`,
      });
    } catch {
      toast({ title: "Could not regenerate", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Goals & Strategy"
        description="Define what you're investing for, and let AI design the path to get there."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Target className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">Investment Goals</h3>
          </div>
          {goalsLoading ? (
            <div className="space-y-3">
              {[...Array(4)].map((_, i) => (
                <Skeleton key={i} className="h-10 w-full" />
              ))}
            </div>
          ) : (
            <form onSubmit={handleSave} className="space-y-5">
              <div>
                <Label htmlFor="capital">Total Capital</Label>
                <div className="relative mt-1.5">
                  <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
                    $
                  </span>
                  <Input
                    id="capital"
                    type="number"
                    value={totalCapital}
                    onChange={(e) => setTotalCapital(Number(e.target.value))}
                    className="pl-7"
                  />
                </div>
              </div>

              <div>
                <div className="flex justify-between items-center mb-1.5">
                  <Label htmlFor="return">Target Return</Label>
                  <span className="text-sm font-medium tabular-nums">
                    {targetReturnPct}%
                  </span>
                </div>
                <input
                  id="return"
                  type="range"
                  min={1}
                  max={50}
                  value={targetReturnPct}
                  onChange={(e) => setTargetReturnPct(Number(e.target.value))}
                  className="w-full accent-primary"
                />
                <p className="text-xs text-muted-foreground mt-1">
                  Projected goal: {usd(totalCapital * (1 + targetReturnPct / 100))}
                </p>
              </div>

              <div>
                <Label htmlFor="horizon">Time Horizon (months)</Label>
                <Input
                  id="horizon"
                  type="number"
                  value={timeHorizonMonths}
                  onChange={(e) => setTimeHorizonMonths(Number(e.target.value))}
                  className="mt-1.5"
                />
              </div>

              <div>
                <Label>Risk Tolerance</Label>
                <div className="grid grid-cols-3 gap-2 mt-1.5 p-1 bg-muted rounded-lg">
                  {RISKS.map((r) => (
                    <button
                      key={r}
                      type="button"
                      onClick={() => setRiskTolerance(r)}
                      className={`py-2 text-sm rounded-md transition-all ${
                        riskTolerance === r
                          ? "bg-background shadow-sm font-medium"
                          : "text-muted-foreground hover:text-foreground"
                      }`}
                    >
                      {r}
                    </button>
                  ))}
                </div>
              </div>

              {goals && (
                <div className="pt-2">
                  <div className="flex justify-between text-xs mb-1">
                    <span className="text-muted-foreground">Current Progress</span>
                    <span className="font-medium">{goals.goalProgressPct}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full bg-gradient-to-r from-primary to-emerald-500"
                      style={{ width: `${goals.goalProgressPct}%` }}
                    />
                  </div>
                  {goals.goalProgressNote && (
                    <p className="text-xs text-muted-foreground mt-2">
                      {goals.goalProgressNote}
                    </p>
                  )}
                </div>
              )}

              <Button type="submit" disabled={updateGoals.isPending} className="w-full">
                <Save className="w-4 h-4 mr-2" />
                {updateGoals.isPending ? "Saving…" : "Save Goals"}
              </Button>
            </form>
          )}
        </Card>

        <Card className="p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-primary" />
              <h3 className="font-semibold">Current Strategy</h3>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={handleRegen}
              disabled={regenerate.isPending}
            >
              <Repeat className="w-3 h-3 mr-1" />
              {regenerate.isPending ? "Regenerating…" : "Regenerate"}
            </Button>
          </div>

          {strategyLoading || !strategy ? (
            <Skeleton className="h-72 w-full" />
          ) : (
            <div className="space-y-4">
              <div className="flex items-center gap-4">
                <AllocationDonut allocation={strategy.allocation} size={160} />
                <div className="flex-1 space-y-2">
                  <div>
                    <p className="text-xs text-muted-foreground">Strategy Type</p>
                    <p className="font-semibold">{strategy.strategyType}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Risk Level</p>
                    <p className="font-medium">{strategy.riskLevel}</p>
                  </div>
                  <div>
                    <p className="text-xs text-muted-foreground">Last Generated</p>
                    <p className="text-sm">
                      {format(new Date(strategy.lastGenerated), "MMM d, yyyy h:mm a")}
                    </p>
                  </div>
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <p className="text-xs text-muted-foreground mb-2">Allocation Breakdown</p>
                <div className="space-y-1.5">
                  {strategy.allocation.map((a, i) => (
                    <div
                      key={a.assetClass}
                      className="flex items-center justify-between text-sm"
                    >
                      <div className="flex items-center gap-2">
                        <span
                          className="w-2.5 h-2.5 rounded-sm"
                          style={{ backgroundColor: `hsl(var(--chart-${(i % 5) + 1}))` }}
                        />
                        <span>{a.assetClass}</span>
                      </div>
                      <span className="font-medium tabular-nums">
                        {a.percentage.toFixed(1)}%
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="border-t border-border pt-4">
                <p className="text-xs text-muted-foreground mb-2">Key Rules</p>
                <ul className="text-sm space-y-1">
                  {strategy.keyRules.map((r) => (
                    <li key={r} className="flex gap-2">
                      <span className="text-primary">•</span> <span>{r}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}
        </Card>
      </div>

      <StrategyOptions />
    </div>
  );
}
