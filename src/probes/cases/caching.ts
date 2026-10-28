import { defineProbe } from "../types";
import { cachePrefix } from "../fixtures";
import { base } from "./_util";

const cacheTokens = (u: { cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null }) =>
  `${u.cache_creation_input_tokens ?? 0} written, ${u.cache_read_input_tokens ?? 0} read`;

export const caching = [
  defineProbe({
    id: "TC-CACHE-01",
    title: "Prompt caching with an explicit breakpoint",
    category: "caching",
    purpose:
      "Checks cache_control on a system block creates a cache entry and a repeat request reads it. Caching is a prefix match on the exact request bytes, so a gateway that rewrites bodies (reordering keys, injecting fields) can silently prevent every cache hit.",
    surface: "POST /v1/messages × 2 · system[].cache_control { type: ephemeral }",
    steps: [
      "Build a system prefix above the model's cacheable minimum, starting with a per-run nonce.",
      "Send it with cache_control on the block.",
      "Send the identical request again.",
    ],
    expected: "The first response writes to the cache; the second reads from it (cache_read_input_tokens > 0).",
    cost: "low",
    async run(ctx) {
      const prefix = cachePrefix(ctx.support.cacheMinTokens, `${ctx.nonce}-explicit`);
      const send = () =>
        ctx.client.messages.create({
          ...base(ctx),
          system: [{ type: "text", text: prefix, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: "Reply with OK." }],
        });
      ctx.label("first request (cache write)");
      const first = await send();
      ctx.label("identical request (cache read)");
      const second = await send();
      ctx.check("First request wrote to the cache", (first.usage.cache_creation_input_tokens ?? 0) > 0, cacheTokens(first.usage));
      ctx.check("Second request read from the cache", (second.usage.cache_read_input_tokens ?? 0) > 0, cacheTokens(second.usage));
      ctx.fact("cacheUsage", { first: first.usage, second: second.usage, minTokens: ctx.support.cacheMinTokens });
    },
  }),

  defineProbe({
    id: "TC-CACHE-02",
    title: "Automatic prompt caching (top-level cache_control)",
    category: "caching",
    purpose: "Checks the simplest caching form: cache_control at the top level of the request, which caches the last cacheable block automatically.",
    surface: "POST /v1/messages × 2 · top-level cache_control",
    steps: ["Send a long system prompt with top-level cache_control.", "Send the identical request again."],
    expected: "The second response reads from the cache.",
    cost: "low",
    async run(ctx) {
      const prefix = cachePrefix(ctx.support.cacheMinTokens, `${ctx.nonce}-automatic`);
      const send = () =>
        ctx.client.messages.create({
          ...base(ctx),
          cache_control: { type: "ephemeral" },
          system: prefix,
          messages: [{ role: "user", content: "Reply with OK." }],
        });
      ctx.label("first request (cache write)");
      const first = await send();
      ctx.label("identical request (cache read)");
      const second = await send();
      ctx.advise("First request wrote to the cache", (first.usage.cache_creation_input_tokens ?? 0) > 0, cacheTokens(first.usage));
      ctx.check("Second request read from the cache", (second.usage.cache_read_input_tokens ?? 0) > 0, cacheTokens(second.usage));
    },
  }),

  defineProbe({
    id: "TC-CACHE-03",
    title: "One-hour cache TTL",
    category: "caching",
    purpose: "Checks the extended one-hour cache lifetime is accepted.",
    surface: "POST /v1/messages · cache_control { type: ephemeral, ttl: 1h }",
    steps: ["Send a long system block with cache_control ttl 1h."],
    expected: "HTTP 200 with a cache write.",
    cost: "low",
    async run(ctx) {
      const prefix = cachePrefix(ctx.support.cacheMinTokens, `${ctx.nonce}-1h`);
      const res = await ctx.client.messages.create({
        ...base(ctx),
        system: [{ type: "text", text: prefix, cache_control: { type: "ephemeral", ttl: "1h" } }],
        messages: [{ role: "user", content: "Reply with OK." }],
      });
      ctx.check("ttl 1h accepted", res.type === "message");
      ctx.advise("Cache entry written", (res.usage.cache_creation_input_tokens ?? 0) > 0, cacheTokens(res.usage));
    },
  }),
];
