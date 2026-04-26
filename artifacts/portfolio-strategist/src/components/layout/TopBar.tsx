import { useLocation } from "wouter";
import { Bell, ChevronDown } from "lucide-react";
import { useGetCurrentUser, useGetDashboardSummary } from "@workspace/api-client-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Skeleton } from "@/components/ui/skeleton";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export default function TopBar() {
  const [location] = useLocation();
  const { data: user, isLoading: isLoadingUser } = useGetCurrentUser();
  const { data: summary } = useGetDashboardSummary();

  const isDashboard = location === "/";

  return (
    <header className="h-16 bg-background/80 backdrop-blur-md border-b border-border sticky top-0 z-30 px-6 flex items-center justify-between shrink-0">
      <div className="flex items-center">
        {isDashboard ? (
          <div>
            {isLoadingUser ? (
              <Skeleton className="h-6 w-48 mb-1" />
            ) : (
              <h1 className="text-lg font-semibold">{getGreeting()}, {user?.name?.split(' ')[0]}</h1>
            )}
            <p className="text-xs text-muted-foreground">Let's build wealth the smart way.</p>
          </div>
        ) : (
          <h1 className="text-lg font-semibold capitalize">
            {location.replace("/", "").replace("-", " ")}
          </h1>
        )}
      </div>

      <div className="flex items-center gap-4">
        <div className="flex items-center gap-2 px-3 py-1.5 bg-muted rounded-full text-xs font-medium">
          <div className={`w-2 h-2 rounded-full ${user?.marketStatus === 'Open' ? 'bg-emerald-500' : 'bg-gray-400'}`} />
          <span>Market: {user?.marketStatus || '...'}</span>
          <span className="text-muted-foreground ml-1">{user?.marketTime || ''}</span>
        </div>

        <button className="relative p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-full transition-colors">
          <Bell className="w-5 h-5" />
          {summary && summary.alertsCount > 0 && (
            <span className="absolute top-1.5 right-1.5 w-2 h-2 bg-destructive rounded-full" />
          )}
        </button>

        <DropdownMenu>
          <DropdownMenuTrigger className="flex items-center gap-2 outline-none">
            <Avatar className="w-8 h-8 border border-border">
              <AvatarImage src={user?.avatarUrl || undefined} />
              <AvatarFallback>{user?.name?.[0] || '?'}</AvatarFallback>
            </Avatar>
            <ChevronDown className="w-4 h-4 text-muted-foreground" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>My Account</DropdownMenuLabel>
            <DropdownMenuSeparator />
            <DropdownMenuItem>Profile Settings</DropdownMenuItem>
            <DropdownMenuItem>Notification Preferences</DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="text-destructive">Log out</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
  );
}
