/**
 * llmRouter.ts — Token-efficient Claude routing
 * Routes each task to the cheapest sufficient model.
 * Logs every call to llm_usage_logs for cost monitoring.
 */

import Anthropic from "@anthropic-ai/sdk";
import { jsonrepair } from "jsonrepair";
import { db } from "@workspace/db";
import { llmUsageLogs } from "@workspace/db/schema";

const MODELS = {
  haiku:  "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-4-6",
  opus:   "claude-opus-4-6",
} as const;

type ModelTier = keyof typeof MODELS;

const TASK_CONFIG = {
  assistant_reply:      { model: "haiku"  as ModelTier, maxTokens: 400,  cache: true  },
  approval_summary:     { model: "haiku"  as ModelTier, maxTokens: 150,  cache: false },
  risk_alert:           { model: "haiku"  as ModelTier, maxTokens: 250,  cache: true  },
  portfolio_summary:    { model: "haiku"  as ModelTier, maxTokens: 400,  cache: true  },
  command_parse:        { model: "haiku"  as ModelTier, maxTokens: 150,  cache: false },
  rebalance_check:      { model: "haiku"  as ModelTier, maxTokens: 250,  cache: true  },
  position_review:      { model: "sonnet" as ModelTier, maxTokens: 1500, cache: false },
  strategy_generation:  { model: "sonnet" as ModelTier, maxTokens: 2000, cache: true  },
  trade_decision:       { model: "sonnet" as ModelTier, maxTokens: 200,  cache: true  },
  rebalance_plan:       { model: "sonnet" as ModelTier, maxTokens: 2000, cache: true  },
  market_scan_rs:       { model: "haiku"  as ModelTier, maxTokens: 1000, cache: true  },
  market_scan:          { model: "sonnet" as ModelTier, maxTokens: 8000, cache: true  },
  performance_analysis: { model: "sonnet" as ModelTier, maxTokens: 600,  cache: true  },
  deep_research:        { model: "opus"   as ModelTier, maxTokens: 2000, cache: true  },
  trade_reflection:     { model: "sonnet" as ModelTier, maxTokens: 3000, cache: false },
  rule_generation:      { model: "sonnet" as ModelTier, maxTokens: 8000, cache: false },
} as const;

export type TaskType = keyof typeof TASK_CONFIG;

const COST_PER_M: Record<string, { input: number; output: number; cacheRead: number; cacheWrite: number }> = {
  [MODELS.haiku]:  { input: 0.80,  output: 4.00,  cacheRead: 0.08,  cacheWrite: 1.00  },
  [MODELS.sonnet]: { input: 3.00,  output: 15.00, cacheRead: 0.30,  cacheWrite: 3.75  },
  [MODELS.opus]:   { input: 15.00, output: 75.00, cacheRead: 1.50,  cacheWrite: 18.75 },
};

function estimateCost(m: string, i: number, o: number, cr: number, cw: number): number {
  const r = COST_PER_M[m];
  if (!r) return 0;
  const nonCached = Math.max(0, i - cr - cw);
  return (nonCached / 1e6) * r.input + (cr / 1e6) * r.cacheRead + (cw / 1e6) * r.cacheWrite + (o / 1e6) * r.output;
}

export interface LlmChatRequest {
  taskType:      TaskType;
  userMessage:   string;
  systemContext: string;
  history?:      Array<{ role: "user" | "assistant"; content: string }>;
  overrideTier?: ModelTier;
}

export interface LlmJsonRequest<T> {
  taskType:      TaskType;
  prompt:        string;
  systemContext: string;
  schema:        object;
  fallback:      T;
  overrideTier?: ModelTier;
}

export interface LlmResponse {
  text:             string;
  model:            string;
  taskType:         TaskType;
  inputTokens:      number;
  outputTokens:     number;
  cachedTokens:     number;
  estimatedCostUsd: number;
  latencyMs:        number;
}

export interface LlmJsonResponse<T> extends LlmResponse {
  data:         T;
  parseSuccess: boolean;
}

class LlmRouter {
  private readonly client = new Anthropic();

  async chat(req: LlmChatRequest): Promise<LlmResponse> {
    const config  = TASK_CONFIG[req.taskType];
    const tier    = req.overrideTier ?? config.model;
    const modelId = MODELS[tier];
    const t0      = Date.now();

    const systemContent: Anthropic.TextBlockParam[] = config.cache
      ? [{ type: "text", text: req.systemContext, cache_control: { type: "ephemeral" } }]
      : [{ type: "text", text: req.systemContext }];

    const messages: Anthropic.MessageParam[] = [
      ...(req.history?.map(h => ({ role: h.role, content: h.content })) ?? []),
      { role: "user", content: req.userMessage },
    ];

    let response: Anthropic.Message;
    try {
      response = await this.client.messages.create({
        model:      modelId,
        max_tokens: config.maxTokens,
        system:     systemContent,
        messages,
      });
    } catch (err: any) {
      this.logToDb({
        taskType: req.taskType, model: modelId, success: false,
        error: err.message, input: 0, output: 0, cached: 0, cacheWrite: 0,
        cost: 0, latency: Date.now() - t0,
      });
      throw err;
    }

    const inputTokens      = response.usage.input_tokens;
    const outputTokens     = response.usage.output_tokens;
    const cachedTokens     = (response.usage as any).cache_read_input_tokens   ?? 0;
    const cacheWriteTokens = (response.usage as any).cache_creation_input_tokens ?? 0;
    const costUsd          = estimateCost(modelId, inputTokens, outputTokens, cachedTokens, cacheWriteTokens);
    const latencyMs    = Date.now() - t0;
    const text         = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map(b => b.text).join("");

    console.log(`[LLM] ${req.taskType} (${tier}) — tokens: ${inputTokens} in / ${outputTokens} out — cost: $${costUsd.toFixed(5)} — ${latencyMs}ms`);

    this.logToDb({
      taskType: req.taskType, model: modelId, success: true,
      input: inputTokens, output: outputTokens, cached: cachedTokens, cacheWrite: cacheWriteTokens,
      cost: costUsd, latency: latencyMs,
    }).catch(console.error);

    return {
      text, model: modelId, taskType: req.taskType,
      inputTokens, outputTokens, cachedTokens,
      estimatedCostUsd: costUsd, latencyMs,
    };
  }

  async json<T>(req: LlmJsonRequest<T>): Promise<LlmJsonResponse<T>> {
    const sys = `${req.systemContext}\n\nRespond with ONLY valid JSON. No prose, no markdown fences:\n${JSON.stringify(req.schema, null, 2)}`;
    const base = await this.chat({
      taskType: req.taskType, userMessage: req.prompt,
      systemContext: sys, overrideTier: req.overrideTier,
    });
    let data = req.fallback;
    let parseSuccess = false;
    try {
      // Strip markdown fences (handles ```json ... ``` from any model)
      const stripped = base.text
        .replace(/^```(?:json|JSON)?\s*/m, "")
        .replace(/\s*```\s*$/m, "")
        .trim();
      // Extract outermost JSON object or array
      const start   = stripped.indexOf("{") !== -1 ? stripped.indexOf("{") : stripped.indexOf("[");
      const end     = stripped.lastIndexOf("}") !== -1 ? stripped.lastIndexOf("}") : stripped.lastIndexOf("]");
      const jsonStr = start !== -1 && end > start ? stripped.slice(start, end + 1) : stripped;
      try {
        data = JSON.parse(jsonStr) as T;
      } catch (parseErr) {
        try {
          // Repair unescaped quotes, literal newlines in strings, truncated JSON, etc.
          const repaired = jsonrepair(jsonStr);
          data = JSON.parse(repaired) as T;
          console.log(`[LlmRouter] JSON repaired for ${req.taskType}`);
        } catch (repairErr) {
          const repairMsg = repairErr instanceof Error ? repairErr.message : String(repairErr);
          console.warn(`[LlmRouter] jsonrepair also failed for ${req.taskType} — ${repairMsg} — response(1000): ${base.text.slice(0, 1000)}`);
          throw parseErr; // rethrow to hit outer catch
        }
      }
      parseSuccess = true;
    } catch {
      console.warn(`[LlmRouter] JSON parse failed for ${req.taskType} — length: ${base.text.length}`);
    }
    return { ...base, data, parseSuccess };
  }

  private async logToDb(args: {
    taskType: string; model: string; success: boolean; error?: string;
    input: number; output: number; cached: number; cacheWrite: number; cost: number; latency: number;
  }): Promise<void> {
    try {
      await db.insert(llmUsageLogs).values({
        taskType:         args.taskType,
        model:            args.model,
        inputTokens:      args.input,
        outputTokens:     args.output,
        cachedTokens:     args.cached,
        cacheWriteTokens: args.cacheWrite,
        estimatedCostUsd: String(args.cost.toFixed(6)),
        latencyMs:        args.latency,
        success:          args.success,
        errorMessage:     args.error ?? null,
      });
    } catch (e) {
      console.error("[LlmRouter] DB log failed:", e);
    }
  }
}

export const llm = new LlmRouter();
