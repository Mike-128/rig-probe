import Anthropic from "@anthropic-ai/sdk";
import type { ProbeContext } from "../types";
import { defineProbe } from "../types";
import { base, blocksOf, excerpt, runWithPauseTurn, textOf, toolUses, WEATHER_TOOL } from "./_util";

/**
 * Server tools come in dated versions; newer models take the dynamic-filtering variants, older
 * models and Vertex AI only the basic ones. Try the newest first and fall back on a 400 that names
 * the tool, recording which variant worked.
 */
async function withVariants(
  ctx: ProbeContext,
  variants: string[],
  attempt: (variant: string) => Promise<Anthropic.Message[]>,
): Promise<{ variant: string; messages: Anthropic.Message[] }> {
  for (let i = 0; i < variants.length; i++) {
    const variant = variants[i];
    ctx.label(`tool version ${variant}`);
    try {
      return { variant, messages: await attempt(variant) };
    } catch (err) {
      const last = i === variants.length - 1;
      if (!last && err instanceof Anthropic.BadRequestError) {
        ctx.note(`${variant} was rejected (${excerpt(err.message, 200)}); retrying with ${variants[i + 1]}.`);
        continue;
      }
      throw err;
    }
  }
  throw new Error("unreachable");
}

function resultBlocks(messages: Anthropic.Message[], type: string) {
  return messages.flatMap((m) => blocksOf(m, type));
}

export const serverTools = [
  defineProbe({
    id: "TC-SRV-01",
    title: "Web search",
    category: "server-tools",
    purpose:
      "Checks the web search server tool, which Anthropic runs and bills per search. Through Vertex AI only the basic version exists, so the case falls back to it automatically and records which version worked.",
    surface: "POST /v1/messages · tools web_search_20260209 (falls back to web_search_20250305)",
    steps: ["Offer web_search with max_uses 2.", "Ask a question that needs a search.", "Resume if the turn pauses (pause_turn)."],
    expected: "A web_search_tool_result block whose content is a list of results, not an error object.",
    cost: "medium",
    feature: "web_search",
    async run(ctx) {
      const variants = ctx.support.platform === "vertex" ? ["web_search_20250305"] : ["web_search_20260209", "web_search_20250305"];
      const { variant, messages } = await withVariants(ctx, variants, async (type) => {
        const { all } = await runWithPauseTurn(
          ctx,
          (msgs) =>
            ctx.client.messages.create({
              ...base(ctx),
              tools: [{ type, name: "web_search", max_uses: 2 } as Anthropic.WebSearchTool20250305],
              messages: msgs,
            }),
          [{ role: "user", content: "Search the web for the official Anthropic website and tell me its URL." }],
        );
        return all;
      });
      const results = resultBlocks(messages, "web_search_tool_result");
      ctx.check("A web search was performed", results.length > 0, `${results.length} result block(s)`);
      const errors = results.filter((r) => !Array.isArray(r.content));
      ctx.check("Search results returned, not an error", results.some((r) => Array.isArray(r.content)), errors.length ? JSON.stringify(errors[0].content) : "");
      ctx.advise("Answer mentions anthropic.com", /anthropic\.com/i.test(textOf(messages.at(-1)!)), excerpt(textOf(messages.at(-1)!)));
      ctx.fact("webSearchVersion", variant);
    },
  }),

  defineProbe({
    id: "TC-SRV-02",
    title: "Web fetch",
    category: "server-tools",
    purpose: "Checks the web fetch server tool, which retrieves a URL already present in the conversation. Not offered on Vertex AI.",
    surface: "POST /v1/messages · tools web_fetch_20260209 (falls back to web_fetch_20250910)",
    steps: ["Offer web_fetch.", "Ask for the heading of https://example.com."],
    expected: "A web_fetch_tool_result block with a document, and an answer naming Example Domain.",
    cost: "medium",
    feature: "web_fetch",
    async run(ctx) {
      const { variant, messages } = await withVariants(ctx, ["web_fetch_20260209", "web_fetch_20250910"], async (type) => {
        const { all } = await runWithPauseTurn(
          ctx,
          (msgs) =>
            ctx.client.messages.create({
              ...base(ctx),
              tools: [{ type, name: "web_fetch", max_uses: 2 } as Anthropic.WebFetchTool20250910],
              messages: msgs,
            }),
          [{ role: "user", content: "Fetch https://example.com and tell me the page's main heading." }],
        );
        return all;
      });
      const results = resultBlocks(messages, "web_fetch_tool_result");
      ctx.check("A fetch was performed", results.length > 0, `${results.length} result block(s)`);
      const ok = results.some((r) => (r.content as { type?: string })?.type === "web_fetch_result");
      ctx.check("Fetch returned a document, not an error", ok, results[0] ? excerpt(JSON.stringify(results[0].content), 200) : "");
      ctx.advise("Answer names Example Domain", /example domain/i.test(textOf(messages.at(-1)!)), excerpt(textOf(messages.at(-1)!)));
      ctx.fact("webFetchVersion", variant);
    },
  }),

  defineProbe({
    id: "TC-SRV-03",
    title: "Code execution",
    category: "server-tools",
    purpose: "Checks the code execution server tool, which runs code in an Anthropic-hosted sandbox. Not offered on Vertex AI.",
    surface: "POST /v1/messages · tools code_execution_20260521",
    steps: ["Offer code_execution.", "Ask for a computation whose answer is unlikely to be memorized correctly without running code."],
    expected: "A code execution result block, and the answer 338350.",
    cost: "medium",
    feature: "code_execution",
    async run(ctx) {
      const { all } = await runWithPauseTurn(
        ctx,
        (msgs) => ctx.client.messages.create({ ...base(ctx), tools: [{ type: "code_execution_20260521", name: "code_execution" }], messages: msgs }),
        [{ role: "user", content: "Use the code execution tool to compute the sum of the squares of the integers from 1 to 100. Report just the number." }],
      );
      const ran = all.flatMap((m) => (m.content as { type: string }[]).filter((b) => b.type.endsWith("code_execution_tool_result")));
      ctx.check("Code was executed", ran.length > 0, ran.map((b) => b.type).join(", ") || "no execution block");
      ctx.check("Answer is 338350", /338,?350/.test(textOf(all.at(-1)!)), excerpt(textOf(all.at(-1)!)));
    },
  }),

  defineProbe({
    id: "TC-SRV-04",
    title: "Tool search (BM25) with deferred tools",
    category: "server-tools",
    purpose: "Checks tool search: tools marked defer_loading stay out of context until the model searches for them, which keeps large tool sets affordable.",
    surface: "POST /v1/messages · tools tool_search_tool_bm25_20251119 + defer_loading",
    steps: ["Offer the BM25 tool search tool plus two deferred tools.", "Ask a question that needs one of the deferred tools."],
    expected: "A tool search is performed, and ideally get_weather is then called.",
    cost: "low",
    feature: "tool_search",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        tools: [
          { type: "tool_search_tool_bm25_20251119", name: "tool_search_tool_bm25" },
          { ...WEATHER_TOOL, defer_loading: true },
          {
            name: "get_stock_price",
            description: "Get the latest stock price for a ticker symbol.",
            input_schema: { type: "object", properties: { ticker: { type: "string" } }, required: ["ticker"] },
            defer_loading: true,
          },
        ],
        messages: [{ role: "user", content: "What's the weather in Oslo right now?" }],
      });
      const searched = blocksOf(res, "tool_search_tool_result").length > 0 || blocksOf(res, "server_tool_use").length > 0;
      ctx.check("A tool search was performed", searched, (res.content as { type: string }[]).map((b) => b.type).join(", "));
      ctx.advise("The deferred get_weather tool was then called", toolUses(res).some((c) => c.name === "get_weather"), String(res.stop_reason));
    },
  }),
];
