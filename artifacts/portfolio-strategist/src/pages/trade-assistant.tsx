import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { format } from "date-fns";
import { Send, Sparkles, AlertTriangle } from "lucide-react";
import {
  useListAssistantMessages,
  useSendAssistantMessage,
  useGetTradeSuggestions,
  useApplyTradeSuggestion,
  getListAssistantMessagesQueryKey,
  getGetTradeSuggestionsQueryKey,
  getGetLastTradeSuggestionQueryKey,
} from "@workspace/api-client-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { useToast } from "@/hooks/use-toast";
import PageHeader from "@/components/PageHeader";
import { usd } from "@/lib/format";

const PROMPTS = [
  "Should I rebalance now?",
  "What's my biggest risk right now?",
  "How am I doing vs the market?",
  "Generate a new strategy for me",
];

export default function TradeAssistant() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [input, setInput] = useState("");
  const scrollRef = useRef<HTMLDivElement>(null);

  const { data: messages, isLoading: messagesLoading } = useListAssistantMessages();
  const { data: suggestions } = useGetTradeSuggestions();
  const sendMessage = useSendAssistantMessage();
  const applyTrade = useApplyTradeSuggestion();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages]);

  const send = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    try {
      await sendMessage.mutateAsync({ data: { content: t } });
      await queryClient.invalidateQueries({
        queryKey: getListAssistantMessagesQueryKey(),
      });
      setInput("");
    } catch {
      toast({ title: "Message failed", variant: "destructive" });
    }
  };

  const apply = async (id: string) => {
    try {
      await applyTrade.mutateAsync({ id });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: getGetTradeSuggestionsQueryKey() }),
        queryClient.invalidateQueries({ queryKey: getGetLastTradeSuggestionQueryKey() }),
      ]);
      toast({ title: "Trade marked as applied" });
    } catch {
      toast({ title: "Could not apply trade", variant: "destructive" });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Trade Assistant"
        description="Chat directly with your AI co-pilot for real-time trade reasoning, entries, and risk."
      />

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <Card className="p-0 overflow-hidden flex flex-col h-[640px] lg:col-span-2">
          <div className="p-4 border-b border-border flex items-center gap-2">
            <Sparkles className="w-4 h-4 text-primary" />
            <h3 className="font-semibold">Conversation</h3>
          </div>

          <div ref={scrollRef} className="flex-1 overflow-y-auto p-5 space-y-4">
            {messagesLoading ? (
              <div className="space-y-3">
                <Skeleton className="h-16 w-3/4" />
                <Skeleton className="h-16 w-2/3 ml-auto" />
              </div>
            ) : messages && messages.length > 0 ? (
              messages.map((m) => (
                <div
                  key={m.id}
                  className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`max-w-[80%] rounded-2xl px-4 py-3 text-sm whitespace-pre-wrap ${
                      m.role === "user"
                        ? "bg-primary text-primary-foreground rounded-br-sm"
                        : "bg-muted text-foreground rounded-bl-sm"
                    }`}
                  >
                    {m.content}
                    <div
                      className={`text-[10px] mt-1.5 ${
                        m.role === "user"
                          ? "text-primary-foreground/70"
                          : "text-muted-foreground"
                      }`}
                    >
                      {format(new Date(m.createdAt), "h:mm a")}
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center text-muted-foreground py-12">
                <Sparkles className="w-8 h-8 mx-auto mb-2 text-primary/40" />
                <p>Start a conversation with your AI strategist.</p>
              </div>
            )}
          </div>

          <div className="border-t border-border p-4 space-y-3">
            <div className="flex flex-wrap gap-2">
              {PROMPTS.map((p) => (
                <button
                  key={p}
                  type="button"
                  onClick={() => send(p)}
                  disabled={sendMessage.isPending}
                  className="text-xs bg-muted hover:bg-muted/70 text-muted-foreground px-3 py-1.5 rounded-full transition-colors"
                >
                  {p}
                </button>
              ))}
            </div>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                send(input);
              }}
              className="relative"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder="Ask about positions, risk, rebalancing, or strategy…"
                disabled={sendMessage.isPending}
                className="w-full bg-background border border-input rounded-lg pl-4 pr-12 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary"
              />
              <Button
                type="submit"
                size="icon"
                disabled={!input.trim() || sendMessage.isPending}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 w-9 h-9"
              >
                <Send className="w-4 h-4" />
              </Button>
            </form>
          </div>
        </Card>

        <div className="space-y-4">
          <Card className="p-5">
            <h3 className="font-semibold mb-4">Trade Suggestions</h3>
            {suggestions && suggestions.length > 0 ? (
              <div className="space-y-4 max-h-[560px] overflow-y-auto">
                {suggestions.map((s) => (
                  <div
                    key={s.id}
                    className="border border-border rounded-lg p-4 space-y-3"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Badge
                          variant="outline"
                          className={
                            s.side === "Buy"
                              ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20"
                              : s.side === "Sell"
                                ? "bg-rose-500/10 text-rose-500 border-rose-500/20"
                                : "bg-amber-500/10 text-amber-500 border-amber-500/20"
                          }
                        >
                          {s.side}
                        </Badge>
                        <span className="font-semibold">{s.pair}</span>
                      </div>
                      {s.status === "Applied" ? (
                        <Badge variant="secondary">Applied</Badge>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => apply(s.id)}
                          disabled={applyTrade.isPending}
                          className="h-7 text-xs"
                        >
                          Apply
                        </Button>
                      )}
                    </div>
                    <p className="text-xs text-muted-foreground">{s.summary}</p>
                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div>
                        <p className="text-muted-foreground">Entry</p>
                        <p className="font-medium tabular-nums">
                          {usd(s.entryRangeLow)}–{usd(s.entryRangeHigh)}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Target</p>
                        <p className="font-medium text-emerald-500 tabular-nums">
                          {usd(s.target)}
                        </p>
                      </div>
                      <div>
                        <p className="text-muted-foreground">Stop</p>
                        <p className="font-medium text-rose-500 tabular-nums">
                          {usd(s.stopLoss)}
                        </p>
                      </div>
                    </div>
                    {s.riskWarning && (
                      <p className="text-[11px] text-amber-500 flex items-start gap-1">
                        <AlertTriangle className="w-3 h-3 mt-0.5 flex-shrink-0" />
                        {s.riskWarning}
                      </p>
                    )}
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground text-center py-6">
                No active suggestions.
              </p>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
