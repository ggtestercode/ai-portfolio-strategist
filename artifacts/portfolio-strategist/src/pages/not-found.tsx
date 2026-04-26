import { Link } from "wouter";
import { Sparkles, ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <div className="text-center max-w-md">
        <div className="w-16 h-16 mx-auto mb-6 rounded-2xl bg-primary/10 flex items-center justify-center">
          <Sparkles className="w-7 h-7 text-primary" />
        </div>
        <p className="text-sm font-mono text-muted-foreground mb-2">404</p>
        <h1 className="text-3xl font-bold mb-3">This page doesn't exist</h1>
        <p className="text-muted-foreground mb-6">
          Let's get you back to your portfolio. The market doesn't wait.
        </p>
        <Link href="/">
          <Button>
            <ArrowLeft className="w-4 h-4 mr-2" />
            Back to Dashboard
          </Button>
        </Link>
      </div>
    </div>
  );
}
