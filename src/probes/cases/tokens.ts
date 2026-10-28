import { defineProbe } from "../types";
import { base, WEATHER_TOOL } from "./_util";

export const tokens = [
  defineProbe({
    id: "TC-TOK-01",
    title: "Token counting",
    category: "tokens",
    purpose:
      "Checks the count_tokens endpoint, which applications use to budget requests before sending them, and compares its count with what the same request is actually billed. Counting itself is free.",
    surface: "POST /v1/messages/count_tokens · client.messages.countTokens()",
    steps: ["Count tokens for a request with a system prompt, a tool, and a user message.", "Send the same request and read billed input tokens."],
    expected: "A positive count within 10% of the billed input tokens.",
    cost: "low",
    async run(ctx) {
      const common = {
        model: ctx.model,
        system: "You are a concise assistant.",
        tools: [WEATHER_TOOL],
        messages: [{ role: "user" as const, content: "What's the weather in Rome?" }],
      };
      const counted = await ctx.client.messages.countTokens(common);
      ctx.check("Token count returned", counted.input_tokens > 0, `${counted.input_tokens} tokens`);
      ctx.label("same request, billed");
      const res = await ctx.client.messages.create({ ...base(ctx), ...common });
      const billed = res.usage.input_tokens;
      const diff = billed ? Math.abs(counted.input_tokens - billed) / billed : 1;
      ctx.advise("Count within 10% of billed input tokens", diff <= 0.1, `counted ${counted.input_tokens}, billed ${billed} (${(diff * 100).toFixed(1)}% apart)`);
      ctx.fact("tokenCount", { counted: counted.input_tokens, billed });
    },
  }),
];
