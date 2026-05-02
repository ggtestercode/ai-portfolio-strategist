import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw, TrendingUp, Eye, TrendingDown, Plus, Trash2 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import PageHeader from "@/components/PageHeader";

interface ScanSignal {
  symbol: string;
  assetClass: string;
  recommendation: "STRONG BUY" | "BUY" | "WATCH" | "AVOID";
  score: number;
  reasoning: string;
  price: number;
  dataTimestamp: string;
}

interface WatchlistItem {
  symbol: string;
  assetClass: string;
}

const REC_COLORS: Record<string, string> = {
  "STRONG BUY": "bg-emerald-500/10 text-emerald-400 border-emerald-500/30",
  "BUY":        "bg-blue-500/10 text-blue-400 border-blue-500/30",
  "WATCH":      "bg-amber-500/10 text-amber-400 border-amber-500/30",
  "AVOID":      "bg-rose-500/10 text-rose-400 border-rose-500/30",
};

const REC_ICON: Record<string, React.FC<{ className?: string }>> = {
  "STRONG BUY": TrendingUp,
  "BUY":        TrendingUp,
  "WATCH":      Eye,
  "AVOID":      TrendingDown,
};

export default function Scanner() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [signals, setSignals] = useState<ScanSignal[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistItem[]>([]);
  const [scanLoading, setScanLoading] = useState(false);
  const [wlLoading, setWlLoading] = useState(false);
  const [newSymbol, setNewSymbol] = useState("");
  const [newClass, setNewClass] = useState("Crypto");
  const [lastScanned, setLastScanned] = useState<string | null>(null);

  const loadSignals = async () => {
    try {
      const res = await fetch("/api/scan/signals");
      const data = await res.json();
      if (data?.opportunities) {
        setSignals(data.opportunities);
        setLastScanned(data.scanTimestamp ?? null);
      }
    } catch {
      // silent
    }
  };

  const loadWatchlist = async () => {
    try {
      const res = await fetch("/api/watchlist");
      const data = await res.json();
      setWatchlist(data.watchlist ?? []);
    } catch {
      // silent
    }
  };

  useState(() => {
    loadSignals();
    loadWatchlist();
  });

  const runScan = async () => {
    setScanLoading(true);
    try {
      const res = await fetch("/api/scan/run", { method: "POST" });
      const data = await res.json();
      if (data?.opportunities) {
        setSignals(data.opportunities);
        setLastScanned(data.scanTimestamp ?? null);
        toast({ title: `Scan complete — ${data.opportunities.length} signals` });
      }
    } catch {
      toast({ title: "Scan failed", variant: "destructive" });
    } finally {
      setScanLoading(false);
    }
  };

  const addToWatchlist = async () => {
    if (!newSymbol.trim()) return;
    setWlLoading(true);
    try {
      await fetch("/api/watchlist/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: newSymbol.trim().toUpperCase(), assetClass: newClass }),
      });
      setNewSymbol("");
      await loadWatchlist();
      toast({ title: `${newSymbol.toUpperCase()} added to watchlist` });
    } catch {
      toast({ title: "Failed to add symbol", variant: "destructive" });
    } finally {
      setWlLoading(false);
    }
  };

  const removeFromWatchlist = async (symbol: string) => {
    try {
      await fetch(`/api/watchlist/${symbol}`, { method: "DELETE" });
      await loadWatchlist();
      toast({ title: `${symbol} removed` });
    } catch {
      toast({ title: "Failed to remove", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Market Scanner"
        description="AI-powered momentum scanner. Finds high-conviction setups across crypto and equities."
      />

      <div className="flex gap-3">
        <Button onClick={runScan} disabled={scanLoading} className="gap-2">
          <RefreshCw className={`w-4 h-4 ${scanLoading ? "animate-spin" : ""}`} />
          {scanLoading ? "Scanning…" : "Run Scan"}
        </Button>
        {lastScanned && (
          <span className="text-xs text-muted-foreground self-center">
            Last scan: {new Date(lastScanned).toLocaleTimeString()}
          </span>
        )}
      </div>

      {scanLoading ? (
        <div className="space-y-3">
          {[...Array(5)].map((_, i) => <Skeleton key={i} className="h-24 w-full" />)}
        </div>
      ) : signals.length === 0 ? (
        <Card className="p-12 text-center">
          <TrendingUp className="w-10 h-10 text-muted-foreground mx-auto mb-3" />
          <h3 className="font-semibold mb-1">No signals yet</h3>
          <p className="text-sm text-muted-foreground">Click Run Scan to generate AI analysis.</p>
        </Card>
      ) : (
        <div className="space-y-3">
          {signals.map((s) => {
            const Icon = REC_ICON[s.recommendation] ?? Eye;
            return (
              <Card key={s.symbol} className="p-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex items-center gap-3">
                    <Icon className="w-5 h-5 text-muted-foreground flex-shrink-0" />
                    <div>
                      <div className="flex items-center gap-2 mb-1">
                        <span className="font-semibold">{s.symbol}</span>
                        <Badge variant="outline" className="text-xs">{s.assetClass}</Badge>
                        <Badge variant="outline" className={`text-xs ${REC_COLORS[s.recommendation] ?? ""}`}>
                          {s.recommendation}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{s.reasoning}</p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="font-semibold">${Number(s.price).toLocaleString()}</p>
                    <p className="text-xs text-muted-foreground">score {Math.round(Number(s.score))}</p>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <div>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
          Watchlist ({watchlist.length})
        </h2>
        <div className="flex gap-2 mb-4">
          <Input
            placeholder="Symbol e.g. AAPL"
            value={newSymbol}
            onChange={e => setNewSymbol(e.target.value)}
            onKeyDown={e => e.key === "Enter" && addToWatchlist()}
            className="max-w-40"
          />
          <select
            value={newClass}
            onChange={e => setNewClass(e.target.value)}
            className="border rounded-md px-2 text-sm bg-background"
          >
            <option>Crypto</option>
            <option>Equity</option>
            <option>ETF</option>
            <option>Commodity</option>
          </select>
          <Button onClick={addToWatchlist} disabled={wlLoading} size="sm" className="gap-1">
            <Plus className="w-4 h-4" /> Add
          </Button>
        </div>
        <div className="flex flex-wrap gap-2">
          {watchlist.map(w => (
            <div key={w.symbol} className="flex items-center gap-1 bg-muted rounded-md px-2 py-1 text-sm">
              <span className="font-medium">{w.symbol}</span>
              <span className="text-muted-foreground text-xs">{w.assetClass}</span>
              <button onClick={() => removeFromWatchlist(w.symbol)} className="ml-1 hover:text-rose-400">
                <Trash2 className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
