import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { ShieldAlert, AlertTriangle, Info, X } from "lucide-react";
import {
  useListAlerts,
  useDismissAlert,
  getListAlertsQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import PageHeader from "@/components/PageHeader";

function severityIcon(sev: string) {
  if (sev === "Critical") return ShieldAlert;
  if (sev === "Warning") return AlertTriangle;
  return Info;
}

function severityColors(sev: string) {
  if (sev === "Critical")
    return {
      bg: "bg-rose-500/5",
      border: "border-l-rose-500",
      icon: "text-rose-500",
      badge: "bg-rose-500/10 text-rose-500 border-rose-500/20",
    };
  if (sev === "Warning")
    return {
      bg: "bg-amber-500/5",
      border: "border-l-amber-500",
      icon: "text-amber-500",
      badge: "bg-amber-500/10 text-amber-500 border-amber-500/20",
    };
  return {
    bg: "bg-blue-500/5",
    border: "border-l-blue-400",
    icon: "text-blue-400",
    badge: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  };
}

export default function Alerts() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: alerts, isLoading } = useListAlerts();
  const dismiss = useDismissAlert();

  const active = (alerts ?? []).filter((a) => !a.dismissed);
  const dismissed = (alerts ?? []).filter((a) => a.dismissed);
  const counts = {
    Critical: active.filter((a) => a.severity === "Critical").length,
    Warning: active.filter((a) => a.severity === "Warning").length,
    Info: active.filter((a) => a.severity === "Info").length,
  };

  const handleDismiss = async (id: string) => {
    try {
      await dismiss.mutateAsync({ id });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getListAlertsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() }),
      ]);
      toast({ title: "Alert dismissed" });
    } catch {
      toast({ title: "Could not dismiss", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Risk & Alerts"
        description="Real-time signals from across your portfolio. Dismiss what you've reviewed."
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card className="p-5 border-l-4 border-l-rose-500">
          <p className="text-xs text-muted-foreground">Critical</p>
          <p className="text-3xl font-bold text-rose-500">{counts.Critical}</p>
        </Card>
        <Card className="p-5 border-l-4 border-l-amber-500">
          <p className="text-xs text-muted-foreground">Warnings</p>
          <p className="text-3xl font-bold text-amber-500">{counts.Warning}</p>
        </Card>
        <Card className="p-5 border-l-4 border-l-blue-400">
          <p className="text-xs text-muted-foreground">Info</p>
          <p className="text-3xl font-bold text-blue-400">{counts.Info}</p>
        </Card>
      </div>

      <div>
        <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
          Active Alerts
        </h2>
        {isLoading ? (
          <div className="space-y-3">
            {[...Array(3)].map((_, i) => (
              <Skeleton key={i} className="h-20 w-full" />
            ))}
          </div>
        ) : active.length === 0 ? (
          <Card className="p-12 text-center">
            <Info className="w-10 h-10 text-emerald-500 mx-auto mb-3" />
            <h3 className="font-semibold mb-1">All Clear</h3>
            <p className="text-sm text-muted-foreground">
              You have no active risk alerts right now.
            </p>
          </Card>
        ) : (
          <div className="space-y-3">
            {active.map((a) => {
              const Icon = severityIcon(a.severity);
              const colors = severityColors(a.severity);
              return (
                <Card
                  key={a.id}
                  className={`p-4 border-l-4 ${colors.border} ${colors.bg}`}
                >
                  <div className="flex items-start gap-3">
                    <Icon className={`w-5 h-5 mt-0.5 flex-shrink-0 ${colors.icon}`} />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <h3 className="font-semibold">{a.title}</h3>
                        <Badge variant="outline" className={`${colors.badge} text-xs`}>
                          {a.severity}
                        </Badge>
                      </div>
                      <p className="text-sm text-muted-foreground">{a.message}</p>
                      <p className="text-xs text-muted-foreground mt-2">
                        {format(new Date(a.createdAt), "MMM d, yyyy h:mm a")}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-8 w-8"
                      onClick={() => handleDismiss(a.id)}
                      disabled={dismiss.isPending}
                    >
                      <X className="w-4 h-4" />
                    </Button>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>

      {dismissed.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold mb-3 text-muted-foreground uppercase tracking-wider">
            Dismissed
          </h2>
          <div className="space-y-2">
            {dismissed.map((a) => (
              <Card key={a.id} className="p-3 opacity-60">
                <div className="flex items-center justify-between text-sm">
                  <span>{a.title}</span>
                  <span className="text-xs text-muted-foreground">
                    {format(new Date(a.createdAt), "MMM d")}
                  </span>
                </div>
              </Card>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
