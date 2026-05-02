import { useState, useEffect } from "react";
import { CheckCircle, XCircle, Clock, AlertTriangle } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import PageHeader from "@/components/PageHeader";

interface Proposal {
  id: string;
  symbol: string;
  side: "buy" | "sell";
  amountUsd: string;
  assetClass: string;
  broker: string;
  rationale: string;
  status: string;
  proposedAt: string;
  approvalSummary?: string;
  score?: string;
  currentPrice?: string;
}

interface PendingApproval {
  proposal: Proposal;
  summary: string;
  expiresAt: string;
}

export default function Approvals() {
  const { toast } = useToast();
  const [pending, setPending] = useState<PendingApproval[]>([]);
  const [history, setHistory] = useState<Proposal[]>([]);
  const [loading, setLoading] = useState(true);
  const [acting, setActing] = useState<string | null>(null);

  const load = async () => {
    try {
      const [pRes, hRes] = await Promise.all([
        fetch("/api/trades/pending"),
        fetch("/api/trades/history"),
      ]);
      const pData = await pRes.json();
      const hData = await hRes.json();
      setPending(pData.pending ?? []);
      setHistory(hData.trades ?? []);
    } catch {
      // silent
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);

  const act = async (id: string, action: "approve" | "reject") => {
    setActing(id);
    try {
      const res = await fetch(`/api/trades/${action}/${id}`, { method: "POST" });
      const data = await res.json();
      toast({ title: data.message ?? (action === "approve" ? "Approved" : "Rejected") });
      await load();
    } catch {
      toast({ title: `Failed to ${action}`, variant: "destructive" });
    } finally {
      setActing(null);
    }
  };

  const sideColor = (side: string) =>
    side === "buy" ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30"
                   : "bg-rose-500/10 text-rose-400 border-rose-500/30";

  const statusColor = (status: string) => {
    if (status === "executed") return "bg-emerald-500/10 text-emerald-400 border-emerald-500/30";
    if (status === "rejected" || status === "failed") return "bg-rose-500/10 text-rose-400 border-rose-500/30";
    if (status === "expired") return "bg-zinc-500/10 text-zinc-400 border-zinc-500/30";
    return "bg-amber-500/10 text-amber-400 border-amber-500/30";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trade Approvals"
        description="Review and approve or reject pending AI-proposed trades."
      />

      <div>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
          Pending ({pending.length})
        </h2>
        {loading ? (
          <div className="space-y-3">
            {[...Array(2)].map((_, i) => <Skeleton key={i} className="h-32 w-full" />)}
          </div>
        ) : pending.length === 0 ? (
          <Card className="p-10 text-center">
            <CheckCircle className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
            <h3 className="font-semibold mb-1">No pending approvals</h3>
            <p className="text-sm text-muted-foreground">All caught up. The scanner will surface new opportunities.</p>
          </Card>
        ) : (
          <div className="space-y-3">
            {pending.map(({ proposal: p, summary, expiresAt }) => (
              <Card key={p.id} className="p-4 border-l-4 border-l-amber-500">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-2 flex-wrap">
                      <span className="font-semibold text-lg">{p.symbol}</span>
                      <Badge variant="outline" className={`${sideColor(p.side)} uppercase`}>{p.side}</Badge>
                      <Badge variant="outline" className="text-xs">{p.assetClass}</Badge>
                      <Badge variant="outline" className="text-xs">{p.broker}</Badge>
                      {p.score && <span className="text-xs text-muted-foreground">score {parseFloat(p.score).toFixed(0)}</span>}
                    </div>
                    <p className="text-sm font-medium mb-1">{summary || p.approvalSummary || p.rationale}</p>
                    {p.currentPrice && (
                      <p className="text-xs text-muted-foreground mb-1">
                        Price: ${parseFloat(p.currentPrice).toLocaleString()}
                      </p>
                    )}
                    <div className="flex items-center gap-2 mt-2 text-xs text-muted-foreground">
                      <Clock className="w-3 h-3" />
                      Expires {new Date(expiresAt).toLocaleTimeString()}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 flex-shrink-0">
                    <p className="text-xl font-bold">${parseFloat(p.amountUsd).toLocaleString()}</p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="outline"
                        className="border-rose-500/30 text-rose-400 hover:bg-rose-500/10 gap-1"
                        disabled={acting === p.id}
                        onClick={() => act(p.id, "reject")}
                      >
                        <XCircle className="w-4 h-4" /> Reject
                      </Button>
                      <Button
                        size="sm"
                        className="bg-emerald-600 hover:bg-emerald-700 gap-1"
                        disabled={acting === p.id}
                        onClick={() => act(p.id, "approve")}
                      >
                        <CheckCircle className="w-4 h-4" /> Approve
                      </Button>
                    </div>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <div>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
          History ({history.length})
        </h2>
        {history.length === 0 ? (
          <p className="text-sm text-muted-foreground">No trade history yet.</p>
        ) : (
          <div className="space-y-2">
            {history.map(p => (
              <Card key={p.id} className="p-3">
                <div className="flex items-center justify-between text-sm">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium">{p.symbol}</span>
                    <Badge variant="outline" className={`${sideColor(p.side)} text-xs uppercase`}>{p.side}</Badge>
                    <span className="text-muted-foreground">${parseFloat(p.amountUsd).toLocaleString()}</span>
                    {p.executionError && (
                      <span className="text-xs text-rose-400 flex items-center gap-1">
                        <AlertTriangle className="w-3 h-3" />{p.executionError}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Badge variant="outline" className={`text-xs ${statusColor(p.status)}`}>{p.status}</Badge>
                    <span className="text-xs text-muted-foreground">
                      {new Date(p.proposedAt).toLocaleDateString()}
                    </span>
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
