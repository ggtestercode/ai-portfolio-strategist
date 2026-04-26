import { useState } from "react";
import { Send, Sparkles } from "lucide-react";
import { useRunCommand } from "@workspace/api-client-react";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";

const SUGGESTIONS = [
  "Should I rebalance?",
  "Is my portfolio too risky?",
  "Generate new strategy"
];

export default function AICommandCenter() {
  const [prompt, setPrompt] = useState("");
  const [lastReply, setLastReply] = useState<string | null>(null);
  const runCommand = useRunCommand();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const handleSubmit = async (text: string) => {
    if (!text.trim()) return;
    
    try {
      const result = await runCommand.mutateAsync({ data: { prompt: text } });
      setLastReply(result.reply);
      setPrompt("");
      // Invalidate relevant queries just in case command affected state
      queryClient.invalidateQueries();
    } catch (error) {
      toast({
        title: "Command failed",
        description: "Could not process your request.",
        variant: "destructive",
      });
    }
  };

  return (
    <div className="bg-card border border-border rounded-xl p-4 flex flex-col shadow-sm">
      <div className="flex items-center gap-2 mb-4 text-primary font-medium">
        <Sparkles className="w-4 h-4" />
        <span>AI Command Center</span>
      </div>

      <div className="flex-1 flex flex-col">
        {lastReply && (
          <div className="bg-primary/5 border border-primary/20 text-sm p-3 rounded-lg mb-4 text-foreground/90 whitespace-pre-wrap">
            {lastReply}
          </div>
        )}

        <div className="mt-auto">
          <div className="flex flex-wrap gap-2 mb-3">
            {SUGGESTIONS.map((sug) => (
              <button
                key={sug}
                onClick={() => handleSubmit(sug)}
                disabled={runCommand.isPending}
                className="text-xs bg-muted hover:bg-muted/80 text-muted-foreground px-3 py-1.5 rounded-full transition-colors whitespace-nowrap"
              >
                {sug}
              </button>
            ))}
          </div>

          <form 
            onSubmit={(e) => { e.preventDefault(); handleSubmit(prompt); }}
            className="relative"
          >
            <input
              type="text"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Type your question or command…"
              disabled={runCommand.isPending}
              className="w-full bg-background border border-input rounded-lg pl-4 pr-12 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary focus:border-transparent transition-all"
            />
            <Button
              type="submit"
              size="icon"
              variant="ghost"
              disabled={!prompt.trim() || runCommand.isPending}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 text-primary hover:text-primary hover:bg-primary/10"
            >
              <Send className="w-4 h-4" />
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
