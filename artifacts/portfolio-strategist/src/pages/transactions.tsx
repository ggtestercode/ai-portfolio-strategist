import { useMemo, useState } from "react";
import { format } from "date-fns";
import { useListTransactions } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import PageHeader from "@/components/PageHeader";
import { usd, trendColor } from "@/lib/format";

const TYPES = ["All", "Buy", "Sell", "Deposit", "Withdraw", "Dividend", "Rebalance"];

function statusColor(status: string) {
  if (status === "Completed")
    return "bg-emerald-500/10 text-emerald-500 border-emerald-500/20";
  if (status === "Pending")
    return "bg-amber-500/10 text-amber-500 border-amber-500/20";
  return "bg-rose-500/10 text-rose-500 border-rose-500/20";
}

function typeColor(type: string) {
  if (type === "Buy") return "text-emerald-500";
  if (type === "Sell") return "text-rose-500";
  if (type === "Dividend") return "text-blue-400";
  if (type === "Rebalance") return "text-violet-400";
  return "text-muted-foreground";
}

export default function Transactions() {
  const [filter, setFilter] = useState("All");
  const { data: txs, isLoading } = useListTransactions({ limit: 100 });

  const filtered = useMemo(() => {
    if (!txs) return [];
    if (filter === "All") return txs;
    return txs.filter((t) => t.type === filter);
  }, [txs, filter]);

  return (
    <div className="space-y-6">
      <PageHeader
        title="Transactions"
        description="Every buy, sell, deposit, and rebalance — fully searchable."
      />

      <Card className="p-0 overflow-hidden">
        <div className="p-4 border-b border-border flex items-center justify-between">
          <h3 className="font-semibold">All Activity</h3>
          <Select value={filter} onValueChange={setFilter}>
            <SelectTrigger className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {TYPES.map((t) => (
                <SelectItem key={t} value={t}>
                  {t}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        {isLoading ? (
          <div className="p-5 space-y-2">
            {[...Array(8)].map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-12 text-center text-muted-foreground">
            No transactions matched.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-muted/30">
                <tr className="text-xs text-muted-foreground">
                  <th className="text-left px-5 py-3 font-medium">Date</th>
                  <th className="text-left py-3 font-medium">Type</th>
                  <th className="text-left py-3 font-medium">Asset</th>
                  <th className="text-right py-3 font-medium">Amount</th>
                  <th className="text-right py-3 font-medium">Value</th>
                  <th className="text-right py-3 font-medium">Status</th>
                  <th className="text-left px-5 py-3 font-medium">Note</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((t) => (
                  <tr
                    key={t.id}
                    className="border-t border-border/50 hover:bg-muted/30 transition-colors"
                  >
                    <td className="px-5 py-3 text-muted-foreground tabular-nums">
                      {format(new Date(t.occurredAt), "MMM d, h:mm a")}
                    </td>
                    <td className={`py-3 font-medium ${typeColor(t.type)}`}>{t.type}</td>
                    <td className="py-3">{t.asset}</td>
                    <td
                      className={`py-3 text-right tabular-nums ${trendColor(t.amount)}`}
                    >
                      {t.amount >= 0 ? "+" : ""}
                      {t.amount.toLocaleString(undefined, { maximumFractionDigits: 6 })}
                    </td>
                    <td className="py-3 text-right tabular-nums font-medium">
                      {usd(Math.abs(t.value))}
                    </td>
                    <td className="py-3 text-right">
                      <Badge variant="outline" className={`${statusColor(t.status)} text-xs`}>
                        {t.status}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-xs text-muted-foreground max-w-xs truncate">
                      {t.note ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
