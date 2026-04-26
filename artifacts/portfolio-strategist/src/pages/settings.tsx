import { useEffect, useState } from "react";
import { Sun, Moon, User as UserIcon, Bell, Info } from "lucide-react";
import { useGetCurrentUser } from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Switch } from "@/components/ui/switch";
import { Skeleton } from "@/components/ui/skeleton";
import PageHeader from "@/components/PageHeader";

const THEMES = [
  { id: "dark", label: "Dark", icon: Moon },
  { id: "light", label: "Light", icon: Sun },
] as const;

export default function Settings() {
  const { data: user, isLoading } = useGetCurrentUser();
  const [theme, setTheme] = useState<"dark" | "light">("dark");
  const [notifications, setNotifications] = useState({
    rebalancing: true,
    risk: true,
    weeklyDigest: false,
  });

  useEffect(() => {
    const t = (localStorage.getItem("theme") ?? "dark") as "dark" | "light";
    setTheme(t);
  }, []);

  const applyTheme = (t: "dark" | "light") => {
    setTheme(t);
    localStorage.setItem("theme", t);
    if (t === "dark") document.documentElement.classList.add("dark");
    else document.documentElement.classList.remove("dark");
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Settings"
        description="Manage your account, appearance, and notifications."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <UserIcon className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">Account</h3>
          </div>
          {isLoading || !user ? (
            <div className="flex items-center gap-4">
              <Skeleton className="w-16 h-16 rounded-full" />
              <div className="space-y-2 flex-1">
                <Skeleton className="h-5 w-32" />
                <Skeleton className="h-4 w-48" />
              </div>
            </div>
          ) : (
            <div className="flex items-center gap-4">
              <Avatar className="w-16 h-16">
                <AvatarImage src={user.avatarUrl ?? undefined} />
                <AvatarFallback className="text-lg">{user.name[0]}</AvatarFallback>
              </Avatar>
              <div>
                <p className="font-semibold text-lg">{user.name}</p>
                <p className="text-sm text-muted-foreground">{user.email}</p>
              </div>
            </div>
          )}
        </Card>

        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Sun className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">Appearance</h3>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {THEMES.map((t) => {
              const Icon = t.icon;
              const isActive = theme === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => applyTheme(t.id)}
                  className={`p-4 rounded-lg border-2 transition-all flex items-center gap-3 ${
                    isActive
                      ? "border-primary bg-primary/5"
                      : "border-border hover:border-muted-foreground/30"
                  }`}
                >
                  <Icon className={`w-5 h-5 ${isActive ? "text-primary" : ""}`} />
                  <span className="font-medium">{t.label}</span>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground mt-3">
            Default is Dark. Your choice is remembered on this device.
          </p>
        </Card>

        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Bell className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">Notifications</h3>
          </div>
          <div className="space-y-4">
            {[
              {
                key: "rebalancing" as const,
                label: "Rebalancing alerts",
                desc: "Notify me when allocation drifts beyond target bands.",
              },
              {
                key: "risk" as const,
                label: "Risk alerts",
                desc: "Critical and warning-level events from your portfolio.",
              },
              {
                key: "weeklyDigest" as const,
                label: "Weekly digest",
                desc: "A short Monday-morning summary.",
              },
            ].map((opt) => (
              <div key={opt.key} className="flex items-start justify-between gap-4">
                <div>
                  <p className="font-medium">{opt.label}</p>
                  <p className="text-xs text-muted-foreground">{opt.desc}</p>
                </div>
                <Switch
                  checked={notifications[opt.key]}
                  onCheckedChange={(v) =>
                    setNotifications((s) => ({ ...s, [opt.key]: v }))
                  }
                />
              </div>
            ))}
          </div>
        </Card>

        <Card className="p-6">
          <div className="flex items-center gap-2 mb-4">
            <Info className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">About</h3>
          </div>
          <div className="space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Product</span>
              <span className="font-medium">AI Portfolio Strategist</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Version</span>
              <span className="font-medium">1.0.0</span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Mode</span>
              <span className="font-medium">Live</span>
            </div>
          </div>
          <p className="text-xs text-muted-foreground mt-4 leading-relaxed">
            Your AI co-pilot for serious investing. Defines goals, generates
            personalized strategy, monitors risk, and surfaces actionable trades.
          </p>
        </Card>
      </div>
    </div>
  );
}
