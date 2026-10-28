import type Anthropic from "@anthropic-ai/sdk";
import { defineProbe } from "../types";
import { base, blocksOf, CODEWORD, CODEWORD_TOOL, excerpt, textOf, toolUses } from "./_util";

const PUZZLE =
  "A bat and a ball cost $1.10 in total. The bat costs $1.00 more than the ball. How much does the ball cost? Work it out, then give just the amount.";

export const reasoning = [
  defineProbe({
    id: "TC-THINK-01",
    title: "Adaptive thinking with summarized display",
    category: "reasoning",
    purpose:
      "Checks adaptive thinking and that thinking summaries come back when requested. On current models the display defaults to omitted (empty thinking text), so applications that show reasoning must ask for summarized.",
    surface: "POST /v1/messages · thinking { type: adaptive, display: summarized }",
    steps: ["Send a reasoning puzzle with adaptive thinking and display summarized, at high effort."],
    expected: "A correct answer ($0.05), and a thinking block with readable summary text.",
    cost: "low",
    feature: "adaptive_thinking",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx, { effort: "high", maxTokens: 8000 }),
        thinking: { type: "adaptive", display: "summarized" },
        messages: [{ role: "user", content: PUZZLE }],
      });
      const thinking = blocksOf(res, "thinking");
      ctx.check("Answer is correct ($0.05)", /0?\.05|5 cents|five cents/i.test(textOf(res)), excerpt(textOf(res)));
      ctx.advise("A thinking block was returned", thinking.length > 0, `${thinking.length} block(s); adaptive mode may skip thinking on easy prompts`);
      ctx.advise("Thinking summary text is present", thinking.some((t) => String(t.thinking ?? "").length > 0), excerpt(String(thinking[0]?.thinking ?? "")));
    },
  }),

  defineProbe({
    id: "TC-THINK-02",
    title: "Effort levels (low vs high)",
    category: "reasoning",
    purpose: "Checks output_config.effort is accepted at both ends of the range. Effort is the main cost and depth control on current models.",
    surface: "POST /v1/messages × 2 · output_config.effort",
    steps: ["Send the same puzzle at effort low, then at effort high.", "Record output tokens for each."],
    expected: "Both requests succeed. High effort usually spends at least as many tokens as low.",
    cost: "low",
    feature: "effort",
    async run(ctx) {
      const send = (effort: "low" | "high") =>
        ctx.client.messages.create({ model: ctx.model, max_tokens: 8000, output_config: { effort }, messages: [{ role: "user", content: PUZZLE }] });
      ctx.label("effort low");
      const low = await send("low");
      ctx.label("effort high");
      const high = await send("high");
      ctx.check("effort low accepted", low.type === "message", `${low.usage.output_tokens} output tokens`);
      ctx.check("effort high accepted", high.type === "message", `${high.usage.output_tokens} output tokens`);
      ctx.advise("High effort used at least as many tokens as low", high.usage.output_tokens >= low.usage.output_tokens, `${low.usage.output_tokens} → ${high.usage.output_tokens}`);
      ctx.fact("effortTokens", { low: low.usage.output_tokens, high: high.usage.output_tokens });
    },
  }),

  defineProbe({
    id: "TC-THINK-03",
    title: "Legacy thinking budget (budget_tokens)",
    category: "reasoning",
    purpose:
      "Checks the older fixed-budget thinking configuration. Current models reject it in favor of adaptive thinking and effort; Haiku 4.5 and earlier still require it. Useful to confirm an application written for older models fails loudly, not silently.",
    surface: "POST /v1/messages · thinking { type: enabled, budget_tokens }",
    steps: ["Send the puzzle with thinking enabled and budget_tokens 1024."],
    expected: "A thinking block on models that support budgets; a 400 on current models, which is correct.",
    cost: "low",
    feature: "budget_tokens",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        model: ctx.model,
        max_tokens: 4096,
        thinking: { type: "enabled", budget_tokens: 1024 },
        messages: [{ role: "user", content: PUZZLE }],
      } as Anthropic.MessageCreateParamsNonStreaming);
      ctx.check("Budgeted thinking accepted", res.type === "message");
      ctx.advise("A thinking block was returned", blocksOf(res, "thinking").length > 0);
    },
  }),

  defineProbe({
    id: "TC-THINK-04",
    title: "Thinking blocks preserved across a tool round trip",
    category: "reasoning",
    purpose:
      "Checks thinking blocks survive being sent back with a tool result. They carry signatures the API verifies; a gateway or proxy that rewrites, reorders, or re-serializes request bodies can break them, and the failure appears only on the second request.",
    surface: "POST /v1/messages × 2 · thinking + tool_use → tool_result with prior content replayed",
    steps: [
      "Ask for a codeword with adaptive thinking and the get_codeword tool.",
      "Send the assistant turn back exactly as received, plus the tool result.",
    ],
    expected: "The second request is accepted and the answer reports MARMOT-19.",
    cost: "low",
    feature: "adaptive_thinking",
    async run(ctx) {
      const prompt = "What is today's codeword? Use the get_codeword tool, then tell me the codeword.";
      const params = { ...base(ctx, { effort: "medium", maxTokens: 8000 }), thinking: { type: "adaptive" as const }, tools: [CODEWORD_TOOL] };
      const first = await ctx.client.messages.create({ ...params, messages: [{ role: "user", content: prompt }] });
      const call = toolUses(first)[0];
      ctx.check("First turn requested the tool", Boolean(call), String(first.stop_reason));
      ctx.advise("First turn included a thinking block", blocksOf(first, "thinking").length > 0, `${blocksOf(first, "thinking").length} block(s)`);
      if (!call) return;
      ctx.label("replay thinking + tool_result");
      const second = await ctx.client.messages.create({
        ...params,
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: first.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: `The codeword is ${CODEWORD}.` }] },
        ],
      });
      ctx.check("Replayed thinking accepted", second.type === "message", String(second.stop_reason));
      ctx.check(`Answer reports ${CODEWORD}`, textOf(second).includes(CODEWORD), excerpt(textOf(second)));
    },
  }),
];
