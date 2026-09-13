// AIOS Core — Model Provider.
//
// Abstraction for LLM calls used by the planner.
// Two implementations: OpenAI-compatible API (real) and fallback (keyword-based).

export type { Risk } from "./schema/index.js";

export interface ModelProvider {
  readonly name: string;
  call(prompt: string): Promise<string>;
}

// ── Keyword-based risk inference (fallback) ────────────────────────────

export function inferRisk(goal: string): "low" | "medium" | "high" {
  const g = goal.toLowerCase();
  const high = ["delete", "remove", "drop", "migrate", "rewrite", "refactor",
    "upgrade", "change schema", "modify config", "reorganize"];
  if (high.some((k) => g.includes(k))) return "high";
  const medium = ["add", "update", "modify", "change", "introduce",
    "implement", "create new"];
  if (medium.some((k) => g.includes(k))) return "medium";
  return "low";
}

// ── Fallback provider (no model, keyword-based) ────────────────────────

export function createFallbackProvider(): ModelProvider {
  return {
    name: "fallback",
    call: async (prompt: string) => {
      const goalMatch = prompt.match(/^Goal:\s*(.+)$/m);
      const goal = goalMatch ? goalMatch[1]!.trim() : "unknown";
      const risk = inferRisk(goal);
      const approval = risk === "low" ? "AUTO" : "MANUAL";
      return `task: ${goal}\nrisk: ${risk}\nscope: src/**\nfiles: []\napproval: ${approval}`;
    },
  };
}

// ── OpenAI-compatible provider ─────────────────────────────────────────

export interface OpenAIConfig {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}

export function createOpenAIProvider(config?: OpenAIConfig): ModelProvider {
  const apiKey = config?.apiKey ?? process.env.AIOS_API_KEY ?? process.env.OPENAI_API_KEY ?? "";
  const baseUrl = (config?.baseUrl ?? process.env.AIOS_API_BASE ?? "https://api.openai.com/v1").replace(/\/+$/, "");
  const model = config?.model ?? process.env.AIOS_MODEL ?? "gpt-4o-mini";

  return {
    name: `openai/${model}`,
    call: async (prompt: string) => {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.1,
          max_tokens: 1024,
        }),
      });
      if (!res.ok) {
        throw new Error(`OpenAI API error: ${res.status} ${await res.text()}`);
      }
      const data = await res.json() as { choices: Array<{ message: { content: string } }> };
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}
