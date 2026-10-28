import Anthropic from "@anthropic-ai/sdk";
import { defineProbe } from "../types";
import { base, excerpt, textOf } from "./_util";

export const streaming = [
  defineProbe({
    id: "TC-STRM-01",
    title: "Streaming events in order",
    category: "streaming",
    purpose: "Checks a streamed response arrives as a complete, correctly ordered event sequence, and that the SDK's finalMessage() assembles it.",
    surface: "POST /v1/messages (stream) · client.messages.stream() · finalMessage()",
    steps: ["Stream a short reply and record every event type.", "Compare text from the deltas with finalMessage()."],
    expected: "message_start first, message_stop last, at least one text delta, and finalMessage() text equal to the deltas.",
    cost: "low",
    async run(ctx) {
      const stream = ctx.client.messages.stream({ ...base(ctx), messages: [{ role: "user", content: "Name three colors, comma separated." }] });
      const types: string[] = [];
      let fromDeltas = "";
      for await (const ev of stream) {
        types.push(ev.type);
        if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") fromDeltas += ev.delta.text;
      }
      const final = await stream.finalMessage();
      ctx.check("First event is message_start", types[0] === "message_start", types[0]);
      ctx.check("Last event is message_stop", types.at(-1) === "message_stop", types.at(-1));
      ctx.check("Text arrived as deltas", fromDeltas.length > 0, `${types.filter((t) => t === "content_block_delta").length} delta events`);
      ctx.check("finalMessage() matches the streamed text", textOf(final) === fromDeltas, excerpt(textOf(final)));
      ctx.advise("Final message carries usage", final.usage.output_tokens > 0, String(final.usage.output_tokens));
      ctx.fact("eventTypes", [...new Set(types)]);
    },
  }),

  defineProbe({
    id: "TC-STRM-02",
    title: "Raw event stream (stream: true)",
    category: "streaming",
    purpose: "Checks the lower-level form, create({ stream: true }), which returns raw server-sent events without the helper's accumulation.",
    surface: "POST /v1/messages · client.messages.create({ stream: true })",
    steps: ["Create a streaming request and iterate the raw events to the end."],
    expected: "The stream ends with message_stop and contains a message_delta with a stop_reason.",
    cost: "low",
    async run(ctx) {
      const stream = await ctx.client.messages.create({ ...base(ctx), stream: true, messages: [{ role: "user", content: "Count from 1 to 5." }] });
      const types: string[] = [];
      let stopReason: string | null | undefined;
      for await (const ev of stream) {
        types.push(ev.type);
        if (ev.type === "message_delta") stopReason = ev.delta.stop_reason;
      }
      ctx.check("Stream ended with message_stop", types.at(-1) === "message_stop", types.at(-1));
      ctx.check("message_delta carried a stop_reason", Boolean(stopReason), String(stopReason));
    },
  }),

  defineProbe({
    id: "TC-STRM-03",
    title: "Streaming is delivered incrementally (gateway buffering)",
    category: "streaming",
    purpose:
      "Detects a gateway that buffers server-sent events and releases them all at the end. The response is still correct, so nothing errors, but users see a long pause instead of streaming text. This is the most common streaming fault in API gateways.",
    surface: "POST /v1/messages (stream) · network chunk timing",
    steps: [
      "Stream a response long enough to produce dozens of events.",
      "Record when each network chunk arrives.",
      "Compare the spread between first and last chunk with the total duration.",
    ],
    expected: "Many network chunks spread across the response. A buffered stream arrives in one or two chunks at the very end.",
    cost: "low",
    async run(ctx) {
      const stream = ctx.client.messages.stream({ ...base(ctx), messages: [{ role: "user", content: "Count from 1 to 60, one number per line, no other text." }] });
      await stream.finalMessage();
      const ex = ctx.exchanges().find((e) => e.stream);
      const s = ex?.stream;
      ctx.check("Stream completed", Boolean(s && s.eventCount > 0), s ? `${s.eventCount} events` : "no stream recorded");
      if (!s || s.firstChunkMs === null || s.lastChunkMs === null) return;
      const total = s.lastChunkMs;
      const buffered = s.eventCount >= 10 && (s.chunkCount <= 2 || (s.spreadMs ?? 0) < 0.1 * total);
      ctx.advise(
        "Events arrived incrementally, not all at once",
        !buffered,
        `${s.eventCount} events in ${s.chunkCount} network chunks; first chunk at ${s.firstChunkMs} ms, last at ${s.lastChunkMs} ms (spread ${s.spreadMs} ms)`,
      );
      if (buffered) ctx.note("The gateway appears to buffer the event stream. In Azure API Management, set buffer-response=\"false\" on the forward-request policy for streaming operations.");
      ctx.fact("sseBuffered", buffered);
      ctx.fact("sseTiming", s);
    },
  }),

  defineProbe({
    id: "TC-STRM-04",
    title: "Aborting a stream",
    category: "streaming",
    purpose: "Checks a stream can be cancelled mid-response and the SDK reports it as a user abort, so applications can stop generation (and spend) when a user cancels.",
    surface: "client.messages.stream() · stream.abort()",
    steps: ["Start streaming a long essay.", "Abort on the first text delta.", "Await the final message and capture the error."],
    expected: "The SDK raises APIUserAbortError promptly after abort().",
    cost: "low",
    async run(ctx) {
      const stream = ctx.client.messages.stream({ ...base(ctx), messages: [{ role: "user", content: "Write a 2000-word story about a lighthouse keeper." }] });
      let abortedAt = 0;
      stream.on("text", () => {
        if (!abortedAt) {
          abortedAt = performance.now();
          stream.abort();
        }
      });
      let error: unknown;
      try {
        await stream.finalMessage();
      } catch (err) {
        error = err;
      }
      const after = abortedAt ? Math.round(performance.now() - abortedAt) : -1;
      ctx.check("Abort raised APIUserAbortError", error instanceof Anthropic.APIUserAbortError, error instanceof Error ? error.constructor.name : "no error");
      ctx.advise("Stream stopped within 2 s of abort()", after >= 0 && after < 2000, `${after} ms`);
    },
  }),

  defineProbe({
    id: "TC-STRM-05",
    title: "Stream helpers: text events and finalText()",
    category: "streaming",
    purpose: "Checks the convenience API most applications use: the text event for display and finalText() for the result.",
    surface: "client.messages.stream() · .on(\"text\") · finalText()",
    steps: ["Subscribe to text events and accumulate them.", "Compare with finalText()."],
    expected: "The accumulated text equals finalText().",
    cost: "low",
    async run(ctx) {
      const stream = ctx.client.messages.stream({ ...base(ctx), messages: [{ role: "user", content: "Write one sentence about the sea." }] });
      let acc = "";
      stream.on("text", (delta) => {
        acc += delta;
      });
      const text = await stream.finalText();
      ctx.check("text events produced output", acc.length > 0, excerpt(acc));
      ctx.check("finalText() equals the accumulated text events", text === acc, excerpt(text));
    },
  }),
];
