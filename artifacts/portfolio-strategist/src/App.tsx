import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import Dashboard from "@/pages/dashboard";
import Layout from "@/components/layout/Layout";
import Goals from "@/pages/goals";
import Portfolio from "@/pages/portfolio";
import TradeAssistant from "@/pages/trade-assistant";
import Rebalancing from "@/pages/rebalancing";
import Performance from "@/pages/performance";
import Transactions from "@/pages/transactions";
import Alerts from "@/pages/alerts";
import Backtesting from "@/pages/backtesting";
import Settings from "@/pages/settings";
import Scanner from "@/pages/scanner";
import Approvals from "@/pages/approvals";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={Dashboard} />
        <Route path="/goals" component={Goals} />
        <Route path="/portfolio" component={Portfolio} />
        <Route path="/trade-assistant" component={TradeAssistant} />
        <Route path="/rebalancing" component={Rebalancing} />
        <Route path="/performance" component={Performance} />
        <Route path="/transactions" component={Transactions} />
        <Route path="/alerts" component={Alerts} />
        <Route path="/backtesting" component={Backtesting} />
        <Route path="/settings" component={Settings} />
        <Route path="/scanner" component={Scanner} />
        <Route path="/approvals" component={Approvals} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL?.replace(/\/$/, "") || ""}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
