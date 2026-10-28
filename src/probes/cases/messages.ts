import { defineProbe } from "../types";
import { base, excerpt, textOf } from "./_util";

export const messages = [
  defineProbe({
    id: "TC-MSG-01",
    title: "System prompt as a string",
    category: "messages",
    purpose: "Checks the top-level system parameter in its simplest form reaches the model and steers it.",
    surface: "POST /v1/messages · system: string",
    steps: ["Send a system prompt instructing the model to reply with the word ZEPHYR, and an unrelated user message."],
    expected: "The reply is ZEPHYR, showing the system prompt was applied.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        system: "Whatever the user says, reply with exactly the single word: ZEPHYR",
        messages: [{ role: "user", content: "Hello, how are you today?" }],
      });
      ctx.check("Reply follows the system prompt (ZEPHYR)", /ZEPHYR/.test(textOf(res)), excerpt(textOf(res)));
    },
  }),

  defineProbe({
    id: "TC-MSG-02",
    title: "System prompt as text blocks",
    category: "messages",
    purpose: "Checks the block form of the system parameter, which is the form used for prompt caching.",
    surface: "POST /v1/messages · system: TextBlockParam[]",
    steps: ["Send the system prompt as an array of two text blocks; the instruction is in the second."],
    expected: "The reply is ORCHID, showing both blocks were applied.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        system: [
          { type: "text", text: "You are a terse assistant used for automated testing." },
          { type: "text", text: "Whatever the user says, reply with exactly the single word: ORCHID" },
        ],
        messages: [{ role: "user", content: "Tell me about your day." }],
      });
      ctx.check("Reply follows the second system block (ORCHID)", /ORCHID/.test(textOf(res)), excerpt(textOf(res)));
    },
  }),

  defineProbe({
    id: "TC-MSG-03",
    title: "Multi-turn conversation",
    category: "messages",
    purpose: "Checks prior turns are carried intact. The API is stateless, so the client resends history each time; a gateway that truncates or rewrites bodies breaks this.",
    surface: "POST /v1/messages · messages with user/assistant history",
    steps: ["Send a user turn stating a number, an assistant acknowledgement, then a user turn asking for the number back."],
    expected: "The reply contains 4719.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        messages: [
          { role: "user", content: "Remember the number 4719. Reply only with OK." },
          { role: "assistant", content: "OK" },
          { role: "user", content: "What number did I ask you to remember? Reply with just the number." },
        ],
      });
      ctx.check("Reply recalls 4719 from the first turn", textOf(res).includes("4719"), excerpt(textOf(res)));
    },
  }),

  defineProbe({
    id: "TC-MSG-04",
    title: "Stop sequences",
    category: "messages",
    purpose: "Checks custom stop sequences end generation and are reported back.",
    surface: "POST /v1/messages · stop_sequences",
    steps: ["Set stop_sequences to [\"HALT\"] and ask the model to repeat a phrase containing HALT."],
    expected: "stop_reason is stop_sequence, stop_sequence is HALT, and nothing after HALT appears.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        stop_sequences: ["HALT"],
        messages: [{ role: "user", content: "Repeat exactly this text and nothing else: alpha beta HALT gamma delta" }],
      });
      ctx.check("stop_reason is stop_sequence", res.stop_reason === "stop_sequence", String(res.stop_reason));
      ctx.check("stop_sequence reported as HALT", res.stop_sequence === "HALT", String(res.stop_sequence));
      ctx.advise("No text after the stop sequence", !/gamma|delta/.test(textOf(res)), excerpt(textOf(res)));
    },
  }),

  defineProbe({
    id: "TC-MSG-05",
    title: "max_tokens truncation",
    category: "messages",
    purpose: "Checks a low max_tokens ends the response and is reported as such, so applications can detect truncated output.",
    surface: "POST /v1/messages · max_tokens",
    steps: ["Set max_tokens to 32 and ask for a 500-word essay."],
    expected: "stop_reason is max_tokens.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        model: ctx.model,
        max_tokens: 32,
        messages: [{ role: "user", content: "Write a 500-word essay about rivers." }],
      });
      ctx.check("stop_reason is max_tokens", res.stop_reason === "max_tokens", String(res.stop_reason));
      ctx.advise("Output tokens at or under the cap", res.usage.output_tokens <= 32, String(res.usage.output_tokens));
    },
  }),

  defineProbe({
    id: "TC-MSG-06",
    title: "Request metadata (user_id)",
    category: "messages",
    purpose: "Checks the metadata.user_id field, used for abuse attribution, is accepted rather than stripped or rejected by the gateway.",
    surface: "POST /v1/messages · metadata.user_id",
    steps: ["Send a request with metadata.user_id set to an opaque identifier."],
    expected: "HTTP 200.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        metadata: { user_id: "rig-probe-user-0001" },
        messages: [{ role: "user", content: "Reply with OK." }],
      });
      ctx.check("Request with metadata accepted", res.type === "message");
    },
  }),

  defineProbe({
    id: "TC-MSG-07",
    title: "Mid-conversation system message",
    category: "messages",
    purpose: "Checks a role: system entry inside messages, the cache-friendly way to add an operator instruction mid-conversation. Supported on current models only.",
    surface: "POST /v1/messages · messages[] containing { role: \"system\" }",
    steps: ["Send a user turn, then a system message instructing replies in French."],
    expected: "HTTP 200 with a reply in French.",
    cost: "low",
    feature: "mid_conversation_system",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        messages: [
          { role: "user", content: "Say hello and tell me what day comes after Monday." },
          { role: "system", content: "Reply in French only, in one short sentence." },
        ],
      });
      ctx.check("Request with a mid-conversation system message accepted", res.type === "message");
      ctx.advise("Reply follows it (French)", /bonjour|salut|mardi/i.test(textOf(res)), excerpt(textOf(res)));
    },
  }),
];
