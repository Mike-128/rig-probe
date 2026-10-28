import type { Platform } from "../profile";

/**
 * What each model and platform is documented to support, so a rejection can be told apart from a
 * fault. Sources: Anthropic's Claude API reference as of 2026-10 (model tables and platform
 * availability). Live capabilities from the Models API override this table when available.
 *
 * Unknown models (custom gateway deployment names, models newer than this table) are "unknown":
 * every case runs and results are classified without an expectation.
 */

export type Feature =
  | "adaptive_thinking"
  | "budget_tokens"
  | "effort"
  | "forced_tool_choice"
  | "mid_conversation_system"
  | "fast_mode"
  | "task_budget"
  | "thinking_display_updates"
  | "per_message_effort"
  | "clear_at"
  | "server_fallbacks"
  | "cache_diagnostics"
  | "compaction"
  | "context_editing"
  | "web_search"
  | "web_fetch"
  | "code_execution"
  | "tool_search"
  | "batches"
  | "files"
  | "models_api"
  | "mcp_connector"
  | "agent_skills"
  | "vision"
  | "structured_outputs";

export type Verdict = "supported" | "unsupported" | "unknown";

const KNOWN = [
  "fable-5-1", "mythos-5-1", "fable-5", "mythos-5",
  "opus-5-5", "opus-5", "opus-4-8", "opus-4-7", "opus-4-6", "opus-4-5", "opus-4-1", "opus-4-0",
  "sonnet-5-5", "sonnet-5", "sonnet-4-6", "sonnet-4-5", "sonnet-4-0",
  "haiku-5-5", "haiku-4-5",
] as const;
type Family = (typeof KNOWN)[number];

const GEN5 = ["fable-5-1", "mythos-5-1", "fable-5", "mythos-5", "opus-5-5", "opus-5", "opus-4-8", "opus-4-7", "sonnet-5-5", "sonnet-5", "haiku-5-5"] as const;
const MID_CONVERSATION_SYSTEM = ["opus-5", "opus-5-5", "opus-4-8", "fable-5", "fable-5-1", "mythos-5", "mythos-5-1", "sonnet-5-5", "haiku-5-5"] as const;

/** Model-gated features: families listed support it; other known families do not. */
const MODEL_SUPPORT: Partial<Record<Feature, readonly Family[]>> = {
  adaptive_thinking: [...GEN5, "opus-4-6", "sonnet-4-6"],
  budget_tokens: ["opus-4-6", "sonnet-4-6", "opus-4-5", "opus-4-1", "opus-4-0", "sonnet-4-5", "sonnet-4-0", "haiku-4-5"],
  effort: [...GEN5, "opus-4-6", "sonnet-4-6", "opus-4-5"],
  forced_tool_choice: KNOWN.filter((f) => !["opus-5-5", "sonnet-5-5", "fable-5-1", "mythos-5-1"].includes(f)),
  mid_conversation_system: MID_CONVERSATION_SYSTEM,
  clear_at: MID_CONVERSATION_SYSTEM,
  fast_mode: ["opus-5", "opus-5-5", "opus-4-8"],
  task_budget: ["opus-5", "opus-5-5", "fable-5", "fable-5-1", "sonnet-5-5", "haiku-5-5", "opus-4-8", "opus-4-7"],
  thinking_display_updates: ["fable-5-1", "mythos-5-1", "fable-5", "opus-5-5", "sonnet-5-5"],
  per_message_effort: ["fable-5-1", "mythos-5-1", "opus-5", "opus-5-5", "sonnet-5-5", "haiku-5-5"],
  server_fallbacks: ["fable-5-1", "opus-5-5", "opus-5", "sonnet-5-5"],
  compaction: ["fable-5", "fable-5-1", "mythos-5", "mythos-5-1", "opus-5-5", "opus-5", "opus-4-8", "opus-4-7", "opus-4-6", "sonnet-5-5", "sonnet-5", "sonnet-4-6", "haiku-5-5"],
};

/** Features the upstream platform does not offer at all. Cases for these are not sent. */
const PLATFORM_UNSUPPORTED: Record<Platform, readonly Feature[]> = {
  anthropic: [],
  vertex: ["web_fetch", "code_execution", "batches", "files", "models_api", "mcp_connector", "agent_skills", "fast_mode", "server_fallbacks", "cache_diagnostics", "task_budget"],
};

export const PLATFORM_LABEL: Record<Platform, string> = { anthropic: "the Anthropic API", vertex: "Google Vertex AI" };

/** Which upstream platforms offer a feature at all. Core capabilities are everywhere. */
export function platformAvailability(f?: Feature): Record<Platform, boolean> {
  return {
    anthropic: !f || !PLATFORM_UNSUPPORTED.anthropic.includes(f),
    vertex: !f || !PLATFORM_UNSUPPORTED.vertex.includes(f),
  };
}

/** Model families documented to support a model-gated feature, or null when it is not model-gated. */
export function modelsSupporting(f?: Feature): readonly string[] | null {
  return f ? (MODEL_SUPPORT[f] ?? null) : null;
}

/** Prompt-cache minimum prefix by model; prefixes shorter than this silently don't cache. */
const CACHE_MIN: [readonly Family[], number][] = [
  [["opus-5-5", "opus-5", "fable-5", "mythos-5", "fable-5-1", "mythos-5-1", "sonnet-5-5", "haiku-5-5"], 512],
  [["opus-4-8", "sonnet-5", "sonnet-4-6", "sonnet-4-5", "opus-4-1", "opus-4-0", "sonnet-4-0"], 1024],
  [["opus-4-7"], 2048],
  [["opus-4-6", "opus-4-5", "haiku-4-5"], 4096],
];

/** Normalize a model ID as a gateway or platform may present it: `anthropic.` prefix, `@version`, date suffix. */
export function modelFamily(model: string): Family | null {
  const m = model
    .toLowerCase()
    .replace(/^anthropic\./, "")
    .replace(/@.*$/, "")
    .replace(/-\d{8}$/, "")
    .replace(/^claude-/, "")
    .replace(/-v\d+(:\d+)?$/, "");
  return (KNOWN as readonly string[]).includes(m) ? (m as Family) : null;
}

/** Live capability tree from the Models API (`capabilities`). Untyped by design. */
export type LiveCapabilities = Record<string, unknown>;

export interface SupportView {
  family: string | null;
  platform: Platform;
  forPlatform(f: Feature): Verdict;
  forModel(f: Feature): Verdict;
  /** n/a when the platform lacks it; otherwise the model verdict, with a sentence for the evidence. */
  expect(f?: Feature): { verdict: Verdict | "n/a"; reason: string };
  cacheMinTokens: number;
  setLive(caps: LiveCapabilities): void;
  liveLoaded: boolean;
}

export function createSupport(model: string, platform: Platform): SupportView {
  const family = modelFamily(model);
  let live: LiveCapabilities | undefined;

  const liveVerdict = (f: Feature): Verdict | undefined => {
    if (!live) return undefined;
    const leaf = (path: string[]): boolean | undefined => {
      let cur: unknown = live;
      for (const k of path) {
        if (typeof cur !== "object" || cur === null) return undefined;
        cur = (cur as Record<string, unknown>)[k];
      }
      return typeof cur === "object" && cur !== null && typeof (cur as Record<string, unknown>).supported === "boolean"
        ? ((cur as Record<string, unknown>).supported as boolean)
        : undefined;
    };
    const map: Partial<Record<Feature, string[]>> = {
      adaptive_thinking: ["thinking", "types", "adaptive"],
      budget_tokens: ["thinking", "types", "enabled"],
      effort: ["effort"],
      vision: ["image_input"],
      structured_outputs: ["structured_outputs"],
      compaction: ["context_management", "compact_20260112"],
    };
    const path = map[f];
    if (!path) return undefined;
    const v = leaf(path);
    return v === undefined ? undefined : v ? "supported" : "unsupported";
  };

  const view: SupportView = {
    family,
    platform,
    liveLoaded: false,
    cacheMinTokens: family ? (CACHE_MIN.find(([fams]) => fams.includes(family))?.[1] ?? 4096) : 4096,
    forPlatform(f) {
      return PLATFORM_UNSUPPORTED[platform].includes(f) ? "unsupported" : "supported";
    },
    forModel(f) {
      const fromLive = liveVerdict(f);
      if (fromLive) return fromLive;
      const list = MODEL_SUPPORT[f];
      if (!family) return "unknown";
      if (!list) return "supported";
      return list.includes(family) ? "supported" : "unsupported";
    },
    expect(f) {
      if (!f) return { verdict: "supported", reason: "Core capability, expected everywhere." };
      if (view.forPlatform(f) === "unsupported") {
        return { verdict: "n/a", reason: `Not offered on ${PLATFORM_LABEL[platform]} (platform availability), so nothing was sent.` };
      }
      const v = view.forModel(f);
      const source = liveVerdict(f) ? "the Models API capability report" : "Anthropic's model documentation";
      if (v === "supported") return { verdict: v, reason: `Expected to work on ${model} per ${source}.` };
      if (v === "unsupported") return { verdict: v, reason: `${model} is documented not to support this (${source}); a rejection is the expected result.` };
      return { verdict: v, reason: `${model} is not a model this tool recognizes, so there is no expectation either way.` };
    },
    setLive(caps) {
      live = caps;
      view.liveLoaded = true;
    },
  };
  return view;
}
