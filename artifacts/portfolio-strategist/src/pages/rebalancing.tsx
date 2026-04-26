import { useQueryClient } from "@tanstack/react-query";
import {
  Repeat,
  CheckCircle2,
  ArrowRightLeft,
} from "lucide-react";
import {
  useGetRebalancingSuggestions,
  useApplyRebalancing,
  useGetPortfolioAllocation,
  getGetRebalancingSuggestionsQueryKey,
  getGetPortfolioQueryKey,
  getGetPortfolioAllocationQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import PageHeader from "@/components/PageHeader";
import { usd, pct } from "@/lib/format";

export default function Rebalancing() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: actions, isLoading } = useGetRebalancingSuggestions();
  const { data: allocation } = useGetPortfolioAllocation();
  const apply = useApplyRebalancing();

  const totalDrift = (allocation ?? []).reduce(
    (m, a) => Math.max(m, Math.abs(a.differencePct)),
    0,
  );

  const handleApply = async () => {
    try {
      const res = await apply.mutateAsync();
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetRebalancingSuggestionsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetPortfolioQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetPortfolioAllocationQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }),
      ]);
      toast({
        title: "Rebalancing executed",
        description: `${res.appliedCount} action${res.appliedCount === 1 ? "" : "s"} applied.`,
      });
    } catch {
      toast({ title: "Could not apply", variant: "destructive" });
    }
  };

  const empty = !isLoading && (!actions || actions.length === 0);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Rebalancing"
        description="Restore your portfolio to its target allocation in a single tap."
        action={
          actions && actions.length > 0 ? (
            <Button onClick={handleApply} disabled={apply.isPending}>
              <Repeat className="w-4 h-4 mr-2" />
              {apply.isPending ? "Applying…" : "Apply All"}
            </Button>
          ) : undefined
        }
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">Open Actions</p>
          <p className="text-3xl font-bold">
            {actions ? actions.length : <Skeleton className="h-8 w-12" />}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {actions && actions.length > 0
              ? "Drift detected across asset classes"
              : "Nothing to rebalance right now"}
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">Max Drift</p>
          <p className="text-3xl font-bold tabular-nums">{totalDrift.toFixed(1)}%</p>
          <p className="text-xs text-muted-foreground mt-1">
            Largest deviation from target
          </p>
        </Card>
        <Card className="p-5">
          <p className="text-xs text-muted-foreground mb-1">Total Notional</p>
          <p className="text-3xl font-bold tabular-nums">
            {actions
              ? usd(actions.reduce((s, a) => s + a.amount, 0))
              : <Skeleton className="h-8 w-24" />}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Sum of buy + sell adjustments
          </p>
        </Card>
      </div>

      <Card className="p-0 overflow-hidden">
        <div className="p-5 border-b border-border flex items-center gap-2">
          <ArrowRightLeft className="w-4 h-4 text-primary" />
          <h3 className="font-semibold">Suggested Actions</h3>
        </div>
        {isLoading ? (
          <div className="p-5 space-y-2">
            {[...Array(4)].map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : empty ? (
          <div className="p-12 text-center">
            <CheckCircle2 className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
            <h3 className="font-semibold mb-1">Allocation On Target</h3>
            <p className="text-sm text-muted-foreground">
              Every asset class is within its target band. No action required.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-muted/30">
              <tr className="text-xs text-muted-foreground">
                <th className="text-left px-5 py-3 font-medium">Asset Class</th>
                <th className="text-left py-3 font-medium">Action</th>
                <th className="text-right py-3 font-medium">Current</th>
                <th className="text-right py-3 font-medium">Target</th>
                <th className="text-right py-3 font-medium">Diff</th>
                <th className="text-right px-5 py-3 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody>
              {actions!.map((a) => {
                const allocRow = (allocation ?? []).find(
                  (r) => r.assetClass === a.asset,
                );
                return (
                  <tr
                    key={a.id}
                    className="border-t border-border/50 hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-5 py-4 font-medium">{a.asset}</td>
                    <td className="py-4">
                      <Badge
                        variant="outline"
                        className={
                          a.actionType === "Buy"
                            ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                            : "bg-rose-500/10 text-rose-500 border-rose-500/20"
                        }
                      >
                        {a.actionType}
                      </Badge>
                    </td>
                    <td className="py-4 text-right tabular-nums">
                      {allocRow ? `${allocRow.currentPct.toFixed(1)}%` : "—"}
                    </td>
                    <td className="py-4 text-right tabular-nums text-muted-foreground">
                      {allocRow ? `${allocRow.targetPct.toFixed(1)}%` : "—"}
                    </td>
                    <td className="py-4 text-right tabular-nums">
                      {allocRow ? pct(allocRow.differencePct) : "—"}
                    </td>
                    <td className="px-5 py-4 text-right font-semibold tabular-nums">
                      {usd(a.amount)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
