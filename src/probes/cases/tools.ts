import type Anthropic from "@anthropic-ai/sdk";
import { betaZodTool } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import { defineProbe } from "../types";
import { base, CODEWORD, CODEWORD_TOOL, excerpt, textOf, toolUses, WEATHER_TOOL, weatherFor } from "./_util";

const WEATHER_PROMPT = "What's the weather in Paris right now? Use the get_weather tool.";

export const tools = [
  defineProbe({
    id: "TC-TOOL-01",
    title: "Tool call is emitted",
    category: "tools",
    purpose: "Checks the model returns a well-formed tool_use block when given a client tool and a request that needs it.",
    surface: "POST /v1/messages · tools[], tool_choice auto",
    steps: ["Define get_weather(city).", "Ask for the weather in Paris."],
    expected: "stop_reason is tool_use, with a get_weather call whose city is Paris.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({ ...base(ctx), tools: [WEATHER_TOOL], messages: [{ role: "user", content: WEATHER_PROMPT }] });
      const calls = toolUses(res);
      ctx.check("stop_reason is tool_use", res.stop_reason === "tool_use", String(res.stop_reason));
      ctx.check("get_weather was called", calls.some((c) => c.name === "get_weather"), calls.map((c) => c.name).join(", ") || "no tool calls");
      ctx.check("Input names Paris", calls.some((c) => /paris/i.test(String(c.input.city))), JSON.stringify(calls[0]?.input));
      ctx.advise("tool_use ID present", calls.every((c) => c.id.length > 0));
    },
  }),

  defineProbe({
    id: "TC-TOOL-02",
    title: "Tool round trip (tool_result)",
    category: "tools",
    purpose: "Checks the full client-tool loop: the assistant turn is sent back unchanged with a tool_result, and the model uses the result. This is the core of every agent.",
    surface: "POST /v1/messages × 2 · tool_use → tool_result",
    steps: ["Get a get_weather call as in TC-TOOL-01.", "Return a result containing a reference code.", "Ask the model to report it."],
    expected: "The second response ends with end_turn and quotes the reference code from the tool result.",
    cost: "low",
    async run(ctx) {
      const prompt = `${WEATHER_PROMPT} Include the reference code from the tool result in your answer.`;
      const first = await ctx.client.messages.create({ ...base(ctx), tools: [WEATHER_TOOL], messages: [{ role: "user", content: prompt }] });
      const call = toolUses(first)[0];
      ctx.check("First turn requested the tool", Boolean(call), String(first.stop_reason));
      if (!call) return;
      const result = weatherFor("Paris");
      const ref = result.match(/WX-\d+/)![0];
      ctx.label("send tool_result");
      const second = await ctx.client.messages.create({
        ...base(ctx),
        tools: [WEATHER_TOOL],
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: first.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, content: result }] },
        ],
      });
      ctx.check("Second turn ends normally", second.stop_reason === "end_turn", String(second.stop_reason));
      ctx.check(`Answer uses the tool result (${ref})`, textOf(second).includes(ref), excerpt(textOf(second)));
    },
  }),

  defineProbe({
    id: "TC-TOOL-03",
    title: "Parallel tool calls",
    category: "tools",
    purpose: "Checks the model can request several tool calls in one turn and that all results returned together in one user message are accepted.",
    surface: "POST /v1/messages × 2 · multiple tool_use blocks, multiple tool_result blocks",
    steps: ["Ask for the weather in Paris and Tokyo at once.", "Return every result in a single user message.", "Ask for a combined answer."],
    expected: "Two get_weather calls in one turn, and a final answer covering both cities.",
    cost: "low",
    async run(ctx) {
      const prompt = "Get the current weather for Paris and for Tokyo. Call get_weather for both cities in the same turn.";
      const first = await ctx.client.messages.create({ ...base(ctx), tools: [WEATHER_TOOL], messages: [{ role: "user", content: prompt }] });
      const calls = toolUses(first);
      ctx.check("At least one tool call", calls.length > 0, `${calls.length} call(s)`);
      ctx.advise("Both cities requested in one turn", calls.length >= 2, calls.map((c) => String(c.input.city)).join(", "));
      if (!calls.length) return;
      ctx.label("send all tool_results in one message");
      const second = await ctx.client.messages.create({
        ...base(ctx),
        tools: [WEATHER_TOOL],
        messages: [
          { role: "user", content: prompt },
          { role: "assistant", content: first.content },
          { role: "user", content: calls.map((c) => ({ type: "tool_result" as const, tool_use_id: c.id, content: weatherFor(String(c.input.city)) })) },
        ],
      });
      ctx.check("Results accepted in a single user message", second.type === "message", String(second.stop_reason));
      if (calls.length >= 2) ctx.advise("Final answer covers both cities", /paris/i.test(textOf(second)) && /tokyo/i.test(textOf(second)), excerpt(textOf(second)));
    },
  }),

  defineProbe({
    id: "TC-TOOL-04",
    title: "Tool error result (is_error)",
    category: "tools",
    purpose: "Checks a failed tool can be reported back with is_error: true and the model handles it instead of the request failing.",
    surface: "POST /v1/messages · tool_result with is_error",
    steps: ["Get a get_weather call.", "Return is_error: true with a service-unavailable message."],
    expected: "HTTP 200, and the model acknowledges the tool failed.",
    cost: "low",
    async run(ctx) {
      const first = await ctx.client.messages.create({ ...base(ctx), tools: [WEATHER_TOOL], messages: [{ role: "user", content: WEATHER_PROMPT }] });
      const call = toolUses(first)[0];
      ctx.check("First turn requested the tool", Boolean(call), String(first.stop_reason));
      if (!call) return;
      ctx.label("send tool_result with is_error");
      const second = await ctx.client.messages.create({
        ...base(ctx),
        tools: [WEATHER_TOOL],
        messages: [
          { role: "user", content: WEATHER_PROMPT },
          { role: "assistant", content: first.content },
          { role: "user", content: [{ type: "tool_result", tool_use_id: call.id, is_error: true, content: "Weather service unavailable (HTTP 503)." }] },
        ],
      });
      ctx.check("Error result accepted", second.type === "message", String(second.stop_reason));
      ctx.advise("Model acknowledges the failure", /unavailable|unable|error|couldn['’]?t|could not|not able|problem|issue/i.test(textOf(second)), excerpt(textOf(second)));
    },
  }),

  defineProbe({
    id: "TC-TOOL-05",
    title: "tool_choice: none",
    category: "tools",
    purpose: "Checks tools can be offered but forbidden for one turn.",
    surface: "POST /v1/messages · tool_choice { type: none }",
    steps: ["Offer get_weather with tool_choice none and a request that would normally use it."],
    expected: "No tool_use blocks; a plain text reply.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({ ...base(ctx), tools: [WEATHER_TOOL], tool_choice: { type: "none" }, messages: [{ role: "user", content: WEATHER_PROMPT }] });
      ctx.check("No tool calls", toolUses(res).length === 0, `${toolUses(res).length} call(s)`);
      ctx.check("Plain text reply", textOf(res).length > 0, excerpt(textOf(res)));
    },
  }),

  defineProbe({
    id: "TC-TOOL-06",
    title: "tool_choice: any (forced tool use)",
    category: "tools",
    purpose: "Checks forcing the model to call some tool. Claude Opus 5.5, Sonnet 5.5, Fable 5.1, and Mythos 5.1 reject forced tool use by design; on those, a 400 is the correct result.",
    surface: "POST /v1/messages · tool_choice { type: any }",
    steps: ["Offer get_weather with tool_choice any and an unrelated question."],
    expected: "A get_weather call, or on models without forced tool use, a 400 saying so.",
    cost: "low",
    feature: "forced_tool_choice",
    async run(ctx) {
      const res = await ctx.client.messages.create({ ...base(ctx), tools: [WEATHER_TOOL], tool_choice: { type: "any" }, messages: [{ role: "user", content: "Hello!" }] });
      ctx.check("A tool was called despite an unrelated prompt", toolUses(res).length > 0, String(res.stop_reason));
    },
  }),

  defineProbe({
    id: "TC-TOOL-07",
    title: "tool_choice: tool (named tool)",
    category: "tools",
    purpose: "Checks forcing a specific named tool. Same model restrictions as TC-TOOL-06.",
    surface: "POST /v1/messages · tool_choice { type: tool, name }",
    steps: ["Offer two tools and force get_weather by name."],
    expected: "A get_weather call, or on models without forced tool use, a 400 saying so.",
    cost: "low",
    feature: "forced_tool_choice",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        tools: [WEATHER_TOOL, CODEWORD_TOOL],
        tool_choice: { type: "tool", name: "get_weather" },
        messages: [{ role: "user", content: "Tell me something about Lisbon." }],
      });
      ctx.check("The named tool was called", toolUses(res).some((c) => c.name === "get_weather"), toolUses(res).map((c) => c.name).join(", ") || "no calls");
    },
  }),

  defineProbe({
    id: "TC-TOOL-08",
    title: "disable_parallel_tool_use",
    category: "tools",
    purpose: "Checks a client can limit the model to one tool call per turn.",
    surface: "POST /v1/messages · tool_choice { type: auto, disable_parallel_tool_use: true }",
    steps: ["Ask for two cities' weather with parallel tool use disabled."],
    expected: "At most one tool_use block in the response.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        tools: [WEATHER_TOOL],
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages: [{ role: "user", content: "Get the current weather for Paris and for Tokyo." }],
      });
      ctx.check("At most one tool call", toolUses(res).length <= 1, `${toolUses(res).length} call(s)`);
    },
  }),

  defineProbe({
    id: "TC-TOOL-09",
    title: "Strict tool use (schema-valid input)",
    category: "tools",
    purpose: "Checks strict: true, which guarantees tool input validates against the schema, including enums and no extra fields.",
    surface: "POST /v1/messages · tool.strict = true",
    steps: ["Define a strict tool with a required enum field and additionalProperties: false.", "Ask for a booking that needs it."],
    expected: "The tool input has exactly the declared fields and an allowed enum value.",
    cost: "low",
    async run(ctx) {
      const tool: Anthropic.Tool = {
        name: "book_table",
        description: "Book a restaurant table.",
        strict: true,
        input_schema: {
          type: "object",
          properties: {
            restaurant: { type: "string" },
            party_size: { type: "integer", enum: [1, 2, 3, 4, 5, 6] },
            seating: { type: "string", enum: ["indoor", "outdoor"] },
          },
          required: ["restaurant", "party_size", "seating"],
          additionalProperties: false,
        },
      };
      const res = await ctx.client.messages.create({
        ...base(ctx),
        tools: [tool],
        messages: [{ role: "user", content: "Book a table for 4 at Chez Probe, outdoors please. Use the book_table tool." }],
      });
      const call = toolUses(res).find((c) => c.name === "book_table");
      ctx.check("book_table was called", Boolean(call), String(res.stop_reason));
      if (!call) return;
      const keys = Object.keys(call.input).sort();
      ctx.check("Input has exactly the declared fields", JSON.stringify(keys) === JSON.stringify(["party_size", "restaurant", "seating"]), keys.join(", "));
      ctx.check("Enum values are valid", [1, 2, 3, 4, 5, 6].includes(call.input.party_size as number) && ["indoor", "outdoor"].includes(call.input.seating as string), JSON.stringify(call.input));
    },
  }),

  defineProbe({
    id: "TC-TOOL-10",
    title: "Streaming tool input (eager_input_streaming)",
    category: "tools",
    purpose: "Checks tool input streams as it is generated (input_json_delta) rather than arriving in one burst, which matters for large inputs such as file contents.",
    surface: "POST /v1/messages (stream) · tool.eager_input_streaming = true",
    steps: ["Stream a request with eager_input_streaming on the tool.", "Count input_json_delta events.", "Validate the final parsed input."],
    expected: "One or more input_json_delta events and a final get_weather input naming Paris.",
    cost: "low",
    async run(ctx) {
      const stream = ctx.client.messages.stream({
        ...base(ctx),
        tools: [{ ...WEATHER_TOOL, eager_input_streaming: true }],
        messages: [{ role: "user", content: WEATHER_PROMPT }],
      });
      let deltas = 0;
      for await (const ev of stream) if (ev.type === "content_block_delta" && ev.delta.type === "input_json_delta") deltas++;
      const final = await stream.finalMessage();
      const call = toolUses(final)[0];
      ctx.check("Tool input streamed as input_json_delta", deltas > 0, `${deltas} delta event(s)`);
      ctx.check("Final input is valid and names Paris", Boolean(call) && /paris/i.test(String(call.input.city)), JSON.stringify(call?.input));
      ctx.advise("Input arrived in more than one fragment", deltas > 1, `${deltas} fragment(s); short inputs can legitimately arrive in one`);
    },
  }),

  defineProbe({
    id: "TC-TOOL-11",
    title: "SDK tool runner (betaZodTool)",
    category: "tools",
    purpose: "Checks the SDK's tool runner, which drives the call-execute-respond loop itself and validates input against a Zod schema. It runs on the beta messages API and sends its own anthropic-beta header (message-threads-2026-08-12), so it also depends on the gateway forwarding that header.",
    surface: "client.beta.messages.toolRunner() · betaZodTool",
    steps: ["Define get_codeword with betaZodTool; its run() returns a codeword.", "Run the tool runner to completion."],
    expected: "run() is invoked and the final message reports MARMOT-19.",
    cost: "low",
    async run(ctx) {
      let calls = 0;
      const getCodeword = betaZodTool({
        name: "get_codeword",
        description: "Returns today's access codeword.",
        inputSchema: z.object({}),
        run: async () => {
          calls++;
          return `The codeword is ${CODEWORD}.`;
        },
      });
      const final = await ctx.client.beta.messages.toolRunner({
        ...base(ctx),
        tools: [getCodeword],
        messages: [{ role: "user", content: "What is today's codeword? Use the get_codeword tool." }],
      });
      ctx.check("Tool runner invoked run()", calls > 0, `${calls} call(s)`);
      ctx.check(`Final answer reports ${CODEWORD}`, textOf(final).includes(CODEWORD), excerpt(textOf(final)));
      ctx.advise("Runner finished with end_turn", final.stop_reason === "end_turn", String(final.stop_reason));
    },
  }),

  defineProbe({
    id: "TC-TOOL-12",
    title: "Anthropic-defined client tools (text editor, bash)",
    category: "tools",
    purpose: "Checks the schema-less Anthropic-defined tools that coding agents use. The model knows their input format; the client executes them.",
    surface: "POST /v1/messages · tools text_editor_20250728, bash_20250124",
    steps: ["Declare the text editor and bash tools.", "Ask to see a file's contents."],
    expected: "A tool_use for one of them; ideally the text editor with command view.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        tools: [
          { type: "text_editor_20250728", name: "str_replace_based_edit_tool" },
          { type: "bash_20250124", name: "bash" },
        ],
        messages: [{ role: "user", content: "Show me the contents of /repo/README.md." }],
      });
      const call = toolUses(res)[0];
      ctx.check("A client tool was called", Boolean(call) && ["str_replace_based_edit_tool", "bash"].includes(call.name), call ? `${call.name} ${JSON.stringify(call.input)}` : String(res.stop_reason));
      ctx.advise("Text editor used with command view", call?.name === "str_replace_based_edit_tool" && call.input.command === "view", call ? JSON.stringify(call.input) : "");
    },
  }),

  defineProbe({
    id: "TC-TOOL-13",
    title: "Memory tool",
    category: "tools",
    purpose: "Checks the Anthropic-defined memory tool, which lets the model read and write a client-hosted memory directory across sessions.",
    surface: "POST /v1/messages · tools memory_20250818",
    steps: ["Declare the memory tool.", "Ask a question that should prompt the model to check its memory first."],
    expected: "A memory tool_use, typically command view.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({
        ...base(ctx),
        tools: [{ type: "memory_20250818", name: "memory" }],
        messages: [{ role: "user", content: "Check your memory directory for my saved preferences before answering: what is my favorite color?" }],
      });
      const call = toolUses(res).find((c) => c.name === "memory");
      ctx.check("The memory tool was called", Boolean(call), call ? JSON.stringify(call.input) : String(res.stop_reason));
      ctx.advise("Memory command is view", call?.input.command === "view", call ? String(call.input.command) : "");
    },
  }),
];
