import { Link, useLocation } from "wouter";
import {
  LayoutDashboard, Target, PieChart, MessageSquare,
  Repeat, Activity, Receipt, ShieldAlert, LineChart,
  Settings, Moon, Sun, Sparkles, ScanSearch, CheckCircle2
} from "lucide-react";
import { useGetDashboardSummary } from "@workspace/api-client-react";
import { useEffect, useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";

const MAIN_NAV = [
  { name: "Dashboard", path: "/", icon: LayoutDashboard },
  { name: "Goals & Strategy", path: "/goals", icon: Target },
  { name: "Portfolio", path: "/portfolio", icon: PieChart },
  { name: "Trade Assistant", path: "/trade-assistant", icon: MessageSquare },
  { name: "Rebalancing", path: "/rebalancing", icon: Repeat },
  { name: "Scanner", path: "/scanner", icon: ScanSearch },
  { name: "Approvals", path: "/approvals", icon: CheckCircle2, showBadge: true },
  { name: "Performance", path: "/performance", icon: Activity },
  { name: "Transactions", path: "/transactions", icon: Receipt },
];

const TOOLS_NAV = [
  { name: "Risk & Alerts", path: "/alerts", icon: ShieldAlert },
  { name: "Backtesting", path: "/backtesting", icon: LineChart },
  { name: "Settings", path: "/settings", icon: Settings },
];

export default function Sidebar() {
  const [location] = useLocation();
  const { data: summary, isLoading } = useGetDashboardSummary();
  const [pendingCount, setPendingCount] = useState(0);
  const [isDark, setIsDark] = useState(() => {
    if (typeof window !== "undefined") {
      return localStorage.getItem("theme") !== "light";
    }
    return true;
  });

  useEffect(() => {
    const root = document.documentElement;
    if (isDark) {
      root.classList.add("dark");
      localStorage.setItem("theme", "dark");
    } else {
      root.classList.remove("dark");
      localStorage.setItem("theme", "light");
    }
  }, [isDark]);

  useEffect(() => {
    const fetchPending = () => {
      fetch("/api/trades/pending")
        .then(r => r.json())
        .then((d: { pending?: unknown[] }) => setPendingCount(d.pending?.length ?? 0))
        .catch(() => {});
    };
    fetchPending();
    const id = setInterval(fetchPending, 30_000);
    return () => clearInterval(id);
  }, []);

  return (
    <div className="w-64 border-r border-border bg-sidebar flex flex-col h-full flex-shrink-0">
      <div className="p-6 flex items-center gap-3">
        <div className="bg-primary/10 p-2 rounded-lg text-primary">
          <Sparkles className="w-5 h-5" />
        </div>
        <span className="font-semibold text-sidebar-foreground">AI Strategist</span>
      </div>

      <div className="flex-1 overflow-y-auto py-2 px-4 space-y-8">
        <div>
          <h4 className="text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider mb-3 px-2">Main</h4>
          <nav className="space-y-1">
            {MAIN_NAV.map((item) => {
              const isActive = location === item.path;
              const count = item.showBadge ? pendingCount : 0;
              return (
                <Link key={item.path} href={item.path} className={`flex items-center gap-3 px-2 py-2 rounded-md transition-colors ${isActive ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"}`}>
                  <item.icon className="w-4 h-4 flex-shrink-0" />
                  <span className="flex-1">{item.name}</span>
                  {count > 0 && (
                    <span className="text-xs bg-primary text-primary-foreground rounded-full px-1.5 py-0.5 min-w-[1.25rem] text-center leading-none">
                      {count}
                    </span>
                  )}
                </Link>
              );
            })}
          </nav>
        </div>

        <div>
          <h4 className="text-xs font-semibold text-sidebar-foreground/50 uppercase tracking-wider mb-3 px-2">Tools</h4>
          <nav className="space-y-1">
            {TOOLS_NAV.map((item) => {
              const isActive = location === item.path;
              return (
                <Link key={item.path} href={item.path} className={`flex items-center gap-3 px-2 py-2 rounded-md transition-colors ${isActive ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground/70 hover:text-sidebar-foreground hover:bg-sidebar-accent/50"}`}>
                  <item.icon className="w-4 h-4" />
                  {item.name}
                </Link>
              );
            })}
          </nav>
        </div>
      </div>

      <div className="p-4 border-t border-border space-y-4">
        <div className="bg-card rounded-lg p-4 border border-border shadow-sm">
          <h4 className="text-sm font-medium mb-3">Portfolio Health</h4>
          {isLoading || !summary ? (
            <div className="space-y-2">
              <Skeleton className="h-16 w-full" />
              <Skeleton className="h-4 w-2/3 mx-auto" />
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <div className="relative w-16 h-16 flex items-center justify-center mb-2">
                <svg className="w-full h-full transform -rotate-90">
                  <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="6" fill="transparent" className="text-muted" />
                  <circle cx="32" cy="32" r="28" stroke="currentColor" strokeWidth="6" fill="transparent" strokeDasharray="175.9" strokeDashoffset={175.9 - (175.9 * summary.healthScore) / 100} className="text-primary transition-all duration-1000 ease-out" strokeLinecap="round" />
                </svg>
                <span className="absolute text-lg font-bold">{summary.healthScore}</span>
              </div>
              <p className="text-sm font-medium">{summary.healthLabel}</p>
              {summary.healthNote && <p className="text-xs text-muted-foreground text-center mt-1">{summary.healthNote}</p>}
              <Link href="/performance" className="text-xs text-primary hover:underline mt-3 block">View Details</Link>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-2 text-sm text-sidebar-foreground/70">
            {isDark ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4" />}
            <span>Dark Mode</span>
          </div>
          <Switch checked={isDark} onCheckedChange={setIsDark} />
        </div>
      </div>
    </div>
  );
}
