import type { Usage } from "./recorder";
import { modelFamily } from "./probes/support";

/**
 * Anthropic first-party list prices, USD per million tokens, as of 2026-10. Used only to estimate
 * what a run cost; Vertex AI and gateway pricing differ, so the evidence labels this an estimate.
 * Cache writes are billed at 1.25x input (5-minute TTL); cache reads at the listed rate.
 */
const PRICES: Record<string, { input: number; output: number; cacheRead?: number }> = {
  "fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "mythos-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "fable-5": { input: 10, output: 50, cacheRead: 1 },
  "mythos-5": { input: 10, output: 50, cacheRead: 1 },
  "opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "opus-5": { input: 5, output: 25 },
  "opus-4-8": { input: 5, output: 25 },
  "opus-4-7": { input: 5, output: 25 },
  "opus-4-6": { input: 5, output: 25 },
  "opus-4-5": { input: 5, output: 25 },
  "sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
  "sonnet-5": { input: 2, output: 10 },
  "sonnet-4-6": { input: 3, output: 15 },
  "sonnet-4-5": { input: 3, output: 15 },
  "haiku-5-5": { input: 0.1, output: 0.5 },
  "haiku-4-5": { input: 1, output: 5 },
};

export function estimateCost(model: string, usage: Usage): number | null {
  const family = modelFamily(model);
  const p = family ? PRICES[family] : undefined;
  if (!p) return null;
  const cacheRead = p.cacheRead ?? p.input * 0.1;
  const cost =
    usage.input_tokens * p.input +
    usage.output_tokens * p.output +
    usage.cache_creation_input_tokens * p.input * 1.25 +
    usage.cache_read_input_tokens * cacheRead;
  return cost / 1_000_000;
}

export function emptyUsage(): Usage {
  return { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
}

export function addUsage(a: Usage, b?: Usage): Usage {
  if (!b) return a;
  return {
    input_tokens: a.input_tokens + b.input_tokens,
    output_tokens: a.output_tokens + b.output_tokens,
    cache_creation_input_tokens: a.cache_creation_input_tokens + b.cache_creation_input_tokens,
    cache_read_input_tokens: a.cache_read_input_tokens + b.cache_read_input_tokens,
  };
}
