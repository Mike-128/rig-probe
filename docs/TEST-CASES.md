# Rig Probe test case catalog

_Generated from the test definitions in `src/probes/cases/`. Do not edit by hand; run `npm run catalog`._

Rig Probe checks how much of the Anthropic TypeScript SDK works against a given target: an API gateway in front of the Anthropic API or Google Vertex AI, or either one directly. There are 66 test cases in 14 categories.

## How results are reported

| Result | Meaning |
|---|---|
| Pass | Worked as expected. |
| Warn | Worked, with a caveat worth reading. |
| Fail | Should have worked and did not. |
| Blocked | The gateway refused the request (authentication, route not found, or method not allowed). |
| Unsupported | The model rejected the feature. Expected where the model is documented not to support it. |
| Error | Transient: network, timeout, rate limit, or server error. Re-run before concluding anything. |
| N/A | Not offered on the upstream platform. Nothing was sent. |
| Skipped | Not run: missing configuration, or the prerequisite did not pass. |

TC-CONN-01 always runs first. If it does not pass, every other case is skipped rather than spending requests on a path that cannot work.

Cases marked **opt-in** are left out of the standard selection because they are slow or comparatively expensive.

Availability columns follow Anthropic's platform documentation: a case not offered on the target's upstream platform is reported N/A and nothing is sent.

## Contents

- **Connectivity & auth** — [TC-CONN-01](#tc-conn-01), [TC-CONN-02](#tc-conn-02), [TC-CONN-03](#tc-conn-03), [TC-CONN-04](#tc-conn-04), [TC-CONN-05](#tc-conn-05)
- **Messages** — [TC-MSG-01](#tc-msg-01), [TC-MSG-02](#tc-msg-02), [TC-MSG-03](#tc-msg-03), [TC-MSG-04](#tc-msg-04), [TC-MSG-05](#tc-msg-05), [TC-MSG-06](#tc-msg-06), [TC-MSG-07](#tc-msg-07)
- **Streaming** — [TC-STRM-01](#tc-strm-01), [TC-STRM-02](#tc-strm-02), [TC-STRM-03](#tc-strm-03), [TC-STRM-04](#tc-strm-04), [TC-STRM-05](#tc-strm-05)
- **Images & documents** — [TC-MM-01](#tc-mm-01), [TC-MM-02](#tc-mm-02), [TC-MM-03](#tc-mm-03), [TC-MM-04](#tc-mm-04)
- **Tool use** — [TC-TOOL-01](#tc-tool-01), [TC-TOOL-02](#tc-tool-02), [TC-TOOL-03](#tc-tool-03), [TC-TOOL-04](#tc-tool-04), [TC-TOOL-05](#tc-tool-05), [TC-TOOL-06](#tc-tool-06), [TC-TOOL-07](#tc-tool-07), [TC-TOOL-08](#tc-tool-08), [TC-TOOL-09](#tc-tool-09), [TC-TOOL-10](#tc-tool-10), [TC-TOOL-11](#tc-tool-11), [TC-TOOL-12](#tc-tool-12), [TC-TOOL-13](#tc-tool-13)
- **Structured outputs** — [TC-STRUCT-01](#tc-struct-01), [TC-STRUCT-02](#tc-struct-02)
- **Thinking & effort** — [TC-THINK-01](#tc-think-01), [TC-THINK-02](#tc-think-02), [TC-THINK-03](#tc-think-03), [TC-THINK-04](#tc-think-04)
- **Prompt caching** — [TC-CACHE-01](#tc-cache-01), [TC-CACHE-02](#tc-cache-02), [TC-CACHE-03](#tc-cache-03)
- **Token counting** — [TC-TOK-01](#tc-tok-01)
- **Server tools** — [TC-SRV-01](#tc-srv-01), [TC-SRV-02](#tc-srv-02), [TC-SRV-03](#tc-srv-03), [TC-SRV-04](#tc-srv-04)
- **Message Batches** — [TC-BATCH-01](#tc-batch-01), [TC-BATCH-02](#tc-batch-02)
- **Files API** — [TC-FILE-01](#tc-file-01)
- **SDK behavior** — [TC-SDK-01](#tc-sdk-01), [TC-SDK-02](#tc-sdk-02), [TC-SDK-03](#tc-sdk-03), [TC-SDK-04](#tc-sdk-04)
- **Beta features (anthropic-beta)** — [TC-BETA-01](#tc-beta-01), [TC-BETA-02](#tc-beta-02), [TC-BETA-03](#tc-beta-03), [TC-BETA-04](#tc-beta-04), [TC-BETA-05](#tc-beta-05), [TC-BETA-06](#tc-beta-06), [TC-BETA-07](#tc-beta-07), [TC-BETA-08](#tc-beta-08), [TC-BETA-09](#tc-beta-09), [TC-BETA-10](#tc-beta-10), [TC-BETA-11](#tc-beta-11)

## Connectivity & auth

Can the SDK reach the model at all, with which credential header, and is the API version honored.

### TC-CONN-01

**Basic message request**

Establishes that the SDK can reach the model through this target at all. Every other case depends on it: if it does not pass, the remaining cases are skipped rather than spending requests on a broken path.

| | |
|---|---|
| API surface | `POST /v1/messages · client.messages.create()` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a single user message asking for the exact reply PROBE-OK.
2. Inspect the response object, usage, and request ID.

**Expected result:** HTTP 200 with a message whose text contains PROBE-OK, a model name, token usage, and a request ID.

### TC-CONN-02

**Credential header discovery**

Finds which header the gateway accepts the credential in. This matters for the SDK v1 upgrade: @anthropic-ai/sdk v1 sends API keys as Authorization: Bearer where v0 sent X-Api-Key, so a gateway that reads X-Api-Key or its own header breaks silently on upgrade unless clients are configured for it.

| | |
|---|---|
| API surface | `POST /v1/messages · client.messages.create() with each credential placement` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a minimal request with the configured credential placement.
2. Repeat with Authorization: Bearer (the SDK v1 default) and with X-Api-Key, unless already covered.
3. Treat 401/403 as rejected; any other HTTP status means the credential got past the gateway.

**Expected result:** The configured placement is accepted. The other results are informational and describe the gateway.

### TC-CONN-03

**Models API: retrieve the target model**

Checks the Models endpoint is routed, and loads the model's live capability report. Later cases use that report to know what the model should support, so results don't rely only on this tool's built-in table.

| | |
|---|---|
| API surface | `GET /v1/models/{model_id} · client.models.retrieve()` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Cost | free: Free or no billable tokens |

**Steps**

1. Retrieve the configured model by ID.
2. Record its context window, output limit, and capabilities.

**Expected result:** HTTP 200 with the model's ID, display name, max_input_tokens, max_tokens, and capabilities.

### TC-CONN-04

**Models API: list with auto-pagination**

Checks the list endpoint and the SDK's automatic pagination, which requests further pages as you iterate.

| | |
|---|---|
| API surface | `GET /v1/models · for await (const m of client.models.list())` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Cost | free: Free or no billable tokens |

**Steps**

1. Iterate the model list with a small page size so pagination is exercised.
2. Stop after 100 models.

**Expected result:** At least one model is listed, and the configured model is among them.

### TC-CONN-05

**API version reaches the API unchanged**

Detects a gateway that rewrites or pins anthropic-version. On API version 2026-10-21 (sent by @anthropic-ai/sdk v1), temperature is removed and any request carrying it returns 400; on 2023-06-01 it is accepted. A request with temperature therefore reveals which version the API actually received.

| | |
|---|---|
| API surface | `POST /v1/messages · client.messages.create() with temperature set` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | free: Free or no billable tokens |

**Steps**

1. Read the anthropic-version the SDK sent.
2. Send a request that includes temperature: 1.
3. Compare the outcome with what that version should do.

**Expected result:** On 2026-10-21: HTTP 400 naming the sampling parameter. On 2023-06-01: HTTP 200.

## Messages

Core request shapes: system prompts, multi-turn, stop sequences, limits, metadata.

### TC-MSG-01

**System prompt as a string**

Checks the top-level system parameter in its simplest form reaches the model and steers it.

| | |
|---|---|
| API surface | `POST /v1/messages · system: string` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a system prompt instructing the model to reply with the word ZEPHYR, and an unrelated user message.

**Expected result:** The reply is ZEPHYR, showing the system prompt was applied.

### TC-MSG-02

**System prompt as text blocks**

Checks the block form of the system parameter, which is the form used for prompt caching.

| | |
|---|---|
| API surface | `POST /v1/messages · system: TextBlockParam[]` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send the system prompt as an array of two text blocks; the instruction is in the second.

**Expected result:** The reply is ORCHID, showing both blocks were applied.

### TC-MSG-03

**Multi-turn conversation**

Checks prior turns are carried intact. The API is stateless, so the client resends history each time; a gateway that truncates or rewrites bodies breaks this.

| | |
|---|---|
| API surface | `POST /v1/messages · messages with user/assistant history` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a user turn stating a number, an assistant acknowledgement, then a user turn asking for the number back.

**Expected result:** The reply contains 4719.

### TC-MSG-04

**Stop sequences**

Checks custom stop sequences end generation and are reported back.

| | |
|---|---|
| API surface | `POST /v1/messages · stop_sequences` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Set stop_sequences to ["HALT"] and ask the model to repeat a phrase containing HALT.

**Expected result:** stop_reason is stop_sequence, stop_sequence is HALT, and nothing after HALT appears.

### TC-MSG-05

**max_tokens truncation**

Checks a low max_tokens ends the response and is reported as such, so applications can detect truncated output.

| | |
|---|---|
| API surface | `POST /v1/messages · max_tokens` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Set max_tokens to 32 and ask for a 500-word essay.

**Expected result:** stop_reason is max_tokens.

### TC-MSG-06

**Request metadata (user_id)**

Checks the metadata.user_id field, used for abuse attribution, is accepted rather than stripped or rejected by the gateway.

| | |
|---|---|
| API surface | `POST /v1/messages · metadata.user_id` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a request with metadata.user_id set to an opaque identifier.

**Expected result:** HTTP 200.

### TC-MSG-07

**Mid-conversation system message**

Checks a role: system entry inside messages, the cache-friendly way to add an operator instruction mid-conversation. Supported on current models only.

| | |
|---|---|
| API surface | `POST /v1/messages · messages[] containing { role: "system" }` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-opus-5`, `claude-opus-5-5`, `claude-opus-4-8`, `claude-fable-5`, `claude-fable-5-1`, `claude-mythos-5`, `claude-mythos-5-1`, `claude-sonnet-5-5`, `claude-haiku-5-5` |
| Cost | low: A few cents at most |

**Steps**

1. Send a user turn, then a system message instructing replies in French.

**Expected result:** HTTP 200 with a reply in French.

## Streaming

Server-sent events end to end, including whether the gateway buffers them.

### TC-STRM-01

**Streaming events in order**

Checks a streamed response arrives as a complete, correctly ordered event sequence, and that the SDK's finalMessage() assembles it.

| | |
|---|---|
| API surface | `POST /v1/messages (stream) · client.messages.stream() · finalMessage()` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Stream a short reply and record every event type.
2. Compare text from the deltas with finalMessage().

**Expected result:** message_start first, message_stop last, at least one text delta, and finalMessage() text equal to the deltas.

### TC-STRM-02

**Raw event stream (stream: true)**

Checks the lower-level form, create({ stream: true }), which returns raw server-sent events without the helper's accumulation.

| | |
|---|---|
| API surface | `POST /v1/messages · client.messages.create({ stream: true })` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Create a streaming request and iterate the raw events to the end.

**Expected result:** The stream ends with message_stop and contains a message_delta with a stop_reason.

### TC-STRM-03

**Streaming is delivered incrementally (gateway buffering)**

Detects a gateway that buffers server-sent events and releases them all at the end. The response is still correct, so nothing errors, but users see a long pause instead of streaming text. This is the most common streaming fault in API gateways.

| | |
|---|---|
| API surface | `POST /v1/messages (stream) · network chunk timing` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Stream a response long enough to produce dozens of events.
2. Record when each network chunk arrives.
3. Compare the spread between first and last chunk with the total duration.

**Expected result:** Many network chunks spread across the response. A buffered stream arrives in one or two chunks at the very end.

### TC-STRM-04

**Aborting a stream**

Checks a stream can be cancelled mid-response and the SDK reports it as a user abort, so applications can stop generation (and spend) when a user cancels.

| | |
|---|---|
| API surface | `client.messages.stream() · stream.abort()` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Start streaming a long essay.
2. Abort on the first text delta.
3. Await the final message and capture the error.

**Expected result:** The SDK raises APIUserAbortError promptly after abort().

### TC-STRM-05

**Stream helpers: text events and finalText()**

Checks the convenience API most applications use: the text event for display and finalText() for the result.

| | |
|---|---|
| API surface | `client.messages.stream() · .on("text") · finalText()` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Subscribe to text events and accumulate them.
2. Compare with finalText().

**Expected result:** The accumulated text equals finalText().

## Images & documents

Image, PDF, and plain-text inputs, and citations.

### TC-MM-01

**Image input (base64)**

Checks an inline base64 image reaches the model intact. Gateways with body-size limits or content inspection sometimes damage or reject large JSON bodies.

| | |
|---|---|
| API surface | `POST /v1/messages · image block, source.type base64` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Generate a solid red 64×64 PNG.
2. Send it with a request to name its color in one word.

**Expected result:** The reply says red.

### TC-MM-02

**Image input (URL)**

Checks URL image sources, which Anthropic fetches server-side. Useful to confirm the platform supports it; a failure here can also come from the image host.

| | |
|---|---|
| API surface | `POST /v1/messages · image block, source.type url` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send an image by URL (configurable) with a request to describe it.

**Expected result:** HTTP 200 with a description. With the default image (dice), the description mentions dice.

### TC-MM-03

**PDF document (base64)**

Checks PDF input. The PDF is generated by this tool and contains a codeword the model can only know by reading it.

| | |
|---|---|
| API surface | `POST /v1/messages · document block, source.type base64, application/pdf` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Generate a one-page PDF containing the codeword PELICAN-42.
2. Ask the model for the codeword.

**Expected result:** The reply contains PELICAN-42.

### TC-MM-04

**Citations from a plain-text document**

Checks citations: the response is split into text blocks that point back to the exact passage supporting each claim.

| | |
|---|---|
| API surface | `POST /v1/messages · document block (text) with citations.enabled` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a short plain-text document with citations enabled.
2. Ask where the facility is located.

**Expected result:** The answer names Reykjavik and at least one text block carries a citation quoting the document.

## Tool use

Client tools from a single call through parallel calls, tool_choice, strict schemas, and the SDK tool runner.

### TC-TOOL-01

**Tool call is emitted**

Checks the model returns a well-formed tool_use block when given a client tool and a request that needs it.

| | |
|---|---|
| API surface | `POST /v1/messages · tools[], tool_choice auto` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Define get_weather(city).
2. Ask for the weather in Paris.

**Expected result:** stop_reason is tool_use, with a get_weather call whose city is Paris.

### TC-TOOL-02

**Tool round trip (tool_result)**

Checks the full client-tool loop: the assistant turn is sent back unchanged with a tool_result, and the model uses the result. This is the core of every agent.

| | |
|---|---|
| API surface | `POST /v1/messages × 2 · tool_use → tool_result` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Get a get_weather call as in TC-TOOL-01.
2. Return a result containing a reference code.
3. Ask the model to report it.

**Expected result:** The second response ends with end_turn and quotes the reference code from the tool result.

### TC-TOOL-03

**Parallel tool calls**

Checks the model can request several tool calls in one turn and that all results returned together in one user message are accepted.

| | |
|---|---|
| API surface | `POST /v1/messages × 2 · multiple tool_use blocks, multiple tool_result blocks` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Ask for the weather in Paris and Tokyo at once.
2. Return every result in a single user message.
3. Ask for a combined answer.

**Expected result:** Two get_weather calls in one turn, and a final answer covering both cities.

### TC-TOOL-04

**Tool error result (is_error)**

Checks a failed tool can be reported back with is_error: true and the model handles it instead of the request failing.

| | |
|---|---|
| API surface | `POST /v1/messages · tool_result with is_error` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Get a get_weather call.
2. Return is_error: true with a service-unavailable message.

**Expected result:** HTTP 200, and the model acknowledges the tool failed.

### TC-TOOL-05

**tool_choice: none**

Checks tools can be offered but forbidden for one turn.

| | |
|---|---|
| API surface | `POST /v1/messages · tool_choice { type: none }` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Offer get_weather with tool_choice none and a request that would normally use it.

**Expected result:** No tool_use blocks; a plain text reply.

### TC-TOOL-06

**tool_choice: any (forced tool use)**

Checks forcing the model to call some tool. Claude Opus 5.5, Sonnet 5.5, Fable 5.1, and Mythos 5.1 reject forced tool use by design; on those, a 400 is the correct result.

| | |
|---|---|
| API surface | `POST /v1/messages · tool_choice { type: any }` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-fable-5`, `claude-mythos-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-opus-4-1`, `claude-opus-4-0`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-sonnet-4-0`, `claude-haiku-5-5`, `claude-haiku-4-5` |
| Cost | low: A few cents at most |

**Steps**

1. Offer get_weather with tool_choice any and an unrelated question.

**Expected result:** A get_weather call, or on models without forced tool use, a 400 saying so.

### TC-TOOL-07

**tool_choice: tool (named tool)**

Checks forcing a specific named tool. Same model restrictions as TC-TOOL-06.

| | |
|---|---|
| API surface | `POST /v1/messages · tool_choice { type: tool, name }` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-fable-5`, `claude-mythos-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-opus-4-5`, `claude-opus-4-1`, `claude-opus-4-0`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-sonnet-4-5`, `claude-sonnet-4-0`, `claude-haiku-5-5`, `claude-haiku-4-5` |
| Cost | low: A few cents at most |

**Steps**

1. Offer two tools and force get_weather by name.

**Expected result:** A get_weather call, or on models without forced tool use, a 400 saying so.

### TC-TOOL-08

**disable_parallel_tool_use**

Checks a client can limit the model to one tool call per turn.

| | |
|---|---|
| API surface | `POST /v1/messages · tool_choice { type: auto, disable_parallel_tool_use: true }` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Ask for two cities' weather with parallel tool use disabled.

**Expected result:** At most one tool_use block in the response.

### TC-TOOL-09

**Strict tool use (schema-valid input)**

Checks strict: true, which guarantees tool input validates against the schema, including enums and no extra fields.

| | |
|---|---|
| API surface | `POST /v1/messages · tool.strict = true` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Define a strict tool with a required enum field and additionalProperties: false.
2. Ask for a booking that needs it.

**Expected result:** The tool input has exactly the declared fields and an allowed enum value.

### TC-TOOL-10

**Streaming tool input (eager_input_streaming)**

Checks tool input streams as it is generated (input_json_delta) rather than arriving in one burst, which matters for large inputs such as file contents.

| | |
|---|---|
| API surface | `POST /v1/messages (stream) · tool.eager_input_streaming = true` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Stream a request with eager_input_streaming on the tool.
2. Count input_json_delta events.
3. Validate the final parsed input.

**Expected result:** One or more input_json_delta events and a final get_weather input naming Paris.

### TC-TOOL-11

**SDK tool runner (betaZodTool)**

Checks the SDK's tool runner, which drives the call-execute-respond loop itself and validates input against a Zod schema. It runs on the beta messages API and sends its own anthropic-beta header (message-threads-2026-08-12), so it also depends on the gateway forwarding that header.

| | |
|---|---|
| API surface | `client.beta.messages.toolRunner() · betaZodTool` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Define get_codeword with betaZodTool; its run() returns a codeword.
2. Run the tool runner to completion.

**Expected result:** run() is invoked and the final message reports MARMOT-19.

### TC-TOOL-12

**Anthropic-defined client tools (text editor, bash)**

Checks the schema-less Anthropic-defined tools that coding agents use. The model knows their input format; the client executes them.

| | |
|---|---|
| API surface | `POST /v1/messages · tools text_editor_20250728, bash_20250124` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Declare the text editor and bash tools.
2. Ask to see a file's contents.

**Expected result:** A tool_use for one of them; ideally the text editor with command view.

### TC-TOOL-13

**Memory tool**

Checks the Anthropic-defined memory tool, which lets the model read and write a client-hosted memory directory across sessions.

| | |
|---|---|
| API surface | `POST /v1/messages · tools memory_20250818` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Declare the memory tool.
2. Ask a question that should prompt the model to check its memory first.

**Expected result:** A memory tool_use, typically command view.

## Structured outputs

JSON-schema-constrained responses, including the SDK's parse helper.

### TC-STRUCT-01

**Structured output with the SDK parse helper**

Checks the recommended way to get typed JSON: messages.parse() with a Zod schema, which constrains the output and validates it client-side.

| | |
|---|---|
| API surface | `POST /v1/messages · client.messages.parse() · output_config.format (zodOutputFormat)` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Define a Zod schema with city, country, and is_capital.
2. Ask for facts about Paris via messages.parse().

**Expected result:** parsed_output is non-null and validates: city Paris, is_capital true.

### TC-STRUCT-02

**Structured output with a raw JSON schema**

Checks output_config.format with a hand-written JSON schema on messages.create(), for applications not using Zod.

| | |
|---|---|
| API surface | `POST /v1/messages · output_config.format { type: json_schema }` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a JSON schema requiring name and population fields.
2. Parse the text response as JSON.

**Expected result:** The response text parses as JSON with exactly the required fields and correct types.

## Thinking & effort

Adaptive thinking, effort levels, and thinking blocks surviving a tool round trip.

### TC-THINK-01

**Adaptive thinking with summarized display**

Checks adaptive thinking and that thinking summaries come back when requested. On current models the display defaults to omitted (empty thinking text), so applications that show reasoning must ask for summarized.

| | |
|---|---|
| API surface | `POST /v1/messages · thinking { type: adaptive, display: summarized }` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-fable-5-1`, `claude-mythos-5-1`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5`, `claude-opus-4-6`, `claude-sonnet-4-6` |
| Cost | low: A few cents at most |

**Steps**

1. Send a reasoning puzzle with adaptive thinking and display summarized, at high effort.

**Expected result:** A correct answer ($0.05), and a thinking block with readable summary text.

### TC-THINK-02

**Effort levels (low vs high)**

Checks output_config.effort is accepted at both ends of the range. Effort is the main cost and depth control on current models.

| | |
|---|---|
| API surface | `POST /v1/messages × 2 · output_config.effort` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-fable-5-1`, `claude-mythos-5-1`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5`, `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-opus-4-5` |
| Cost | low: A few cents at most |

**Steps**

1. Send the same puzzle at effort low, then at effort high.
2. Record output tokens for each.

**Expected result:** Both requests succeed. High effort usually spends at least as many tokens as low.

### TC-THINK-03

**Legacy thinking budget (budget_tokens)**

Checks the older fixed-budget thinking configuration. Current models reject it in favor of adaptive thinking and effort; Haiku 4.5 and earlier still require it. Useful to confirm an application written for older models fails loudly, not silently.

| | |
|---|---|
| API surface | `POST /v1/messages · thinking { type: enabled, budget_tokens }` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-opus-4-5`, `claude-opus-4-1`, `claude-opus-4-0`, `claude-sonnet-4-5`, `claude-sonnet-4-0`, `claude-haiku-4-5` |
| Cost | low: A few cents at most |

**Steps**

1. Send the puzzle with thinking enabled and budget_tokens 1024.

**Expected result:** A thinking block on models that support budgets; a 400 on current models, which is correct.

### TC-THINK-04

**Thinking blocks preserved across a tool round trip**

Checks thinking blocks survive being sent back with a tool result. They carry signatures the API verifies; a gateway or proxy that rewrites, reorders, or re-serializes request bodies can break them, and the failure appears only on the second request.

| | |
|---|---|
| API surface | `POST /v1/messages × 2 · thinking + tool_use → tool_result with prior content replayed` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-fable-5-1`, `claude-mythos-5-1`, `claude-fable-5`, `claude-mythos-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-haiku-5-5`, `claude-opus-4-6`, `claude-sonnet-4-6` |
| Cost | low: A few cents at most |

**Steps**

1. Ask for a codeword with adaptive thinking and the get_codeword tool.
2. Send the assistant turn back exactly as received, plus the tool result.

**Expected result:** The second request is accepted and the answer reports MARMOT-19.

## Prompt caching

Cache writes and reads, explicit and automatic.

### TC-CACHE-01

**Prompt caching with an explicit breakpoint**

Checks cache_control on a system block creates a cache entry and a repeat request reads it. Caching is a prefix match on the exact request bytes, so a gateway that rewrites bodies (reordering keys, injecting fields) can silently prevent every cache hit.

| | |
|---|---|
| API surface | `POST /v1/messages × 2 · system[].cache_control { type: ephemeral }` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Build a system prefix above the model's cacheable minimum, starting with a per-run nonce.
2. Send it with cache_control on the block.
3. Send the identical request again.

**Expected result:** The first response writes to the cache; the second reads from it (cache_read_input_tokens > 0).

### TC-CACHE-02

**Automatic prompt caching (top-level cache_control)**

Checks the simplest caching form: cache_control at the top level of the request, which caches the last cacheable block automatically.

| | |
|---|---|
| API surface | `POST /v1/messages × 2 · top-level cache_control` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a long system prompt with top-level cache_control.
2. Send the identical request again.

**Expected result:** The second response reads from the cache.

### TC-CACHE-03

**One-hour cache TTL**

Checks the extended one-hour cache lifetime is accepted.

| | |
|---|---|
| API surface | `POST /v1/messages · cache_control { type: ephemeral, ttl: 1h }` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a long system block with cache_control ttl 1h.

**Expected result:** HTTP 200 with a cache write.

## Token counting

The count_tokens endpoint and how closely it matches billed usage.

### TC-TOK-01

**Token counting**

Checks the count_tokens endpoint, which applications use to budget requests before sending them, and compares its count with what the same request is actually billed. Counting itself is free.

| | |
|---|---|
| API surface | `POST /v1/messages/count_tokens · client.messages.countTokens()` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Count tokens for a request with a system prompt, a tool, and a user message.
2. Send the same request and read billed input tokens.

**Expected result:** A positive count within 10% of the billed input tokens.

## Server tools

Tools Anthropic runs: web search, web fetch, code execution, tool search.

### TC-SRV-01

**Web search**

Checks the web search server tool, which Anthropic runs and bills per search. Through Vertex AI only the basic version exists, so the case falls back to it automatically and records which version worked.

| | |
|---|---|
| API surface | `POST /v1/messages · tools web_search_20260209 (falls back to web_search_20250305)` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | medium: Server-tool usage fees plus extra tokens |

**Steps**

1. Offer web_search with max_uses 2.
2. Ask a question that needs a search.
3. Resume if the turn pauses (pause_turn).

**Expected result:** A web_search_tool_result block whose content is a list of results, not an error object.

### TC-SRV-02

**Web fetch**

Checks the web fetch server tool, which retrieves a URL already present in the conversation. Not offered on Vertex AI.

| | |
|---|---|
| API surface | `POST /v1/messages · tools web_fetch_20260209 (falls back to web_fetch_20250910)` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Cost | medium: Server-tool usage fees plus extra tokens |

**Steps**

1. Offer web_fetch.
2. Ask for the heading of https://example.com.

**Expected result:** A web_fetch_tool_result block with a document, and an answer naming Example Domain.

### TC-SRV-03

**Code execution**

Checks the code execution server tool, which runs code in an Anthropic-hosted sandbox. Not offered on Vertex AI.

| | |
|---|---|
| API surface | `POST /v1/messages · tools code_execution_20260521` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Cost | medium: Server-tool usage fees plus extra tokens |

**Steps**

1. Offer code_execution.
2. Ask for a computation whose answer is unlikely to be memorized correctly without running code.

**Expected result:** A code execution result block, and the answer 338350.

### TC-SRV-04

**Tool search (BM25) with deferred tools**

Checks tool search: tools marked defer_loading stay out of context until the model searches for them, which keeps large tool sets affordable.

| | |
|---|---|
| API surface | `POST /v1/messages · tools tool_search_tool_bm25_20251119 + defer_loading` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Offer the BM25 tool search tool plus two deferred tools.
2. Ask a question that needs one of the deferred tools.

**Expected result:** A tool search is performed, and ideally get_weather is then called.

## Message Batches

The asynchronous batch endpoint.

### TC-BATCH-01

**Message Batches lifecycle (create, retrieve, list, cancel)**

Checks the batch endpoints are routed and behave: a batch can be created, read back, listed, and canceled. Fast, because it cancels instead of waiting. Not offered on Vertex AI.

| | |
|---|---|
| API surface | `POST/GET /v1/messages/batches · client.messages.batches.create/retrieve/list/cancel` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Cost | low: A few cents at most |

**Steps**

1. Create a one-request batch.
2. Retrieve it by ID.
3. List batches.
4. Cancel it.

**Expected result:** Each call succeeds; after cancel the batch is canceling or already ended.

### TC-BATCH-02

**Message Batch completes and returns results** · _opt-in_

Checks a batch runs to completion and its results can be streamed back. Slow: batches usually finish within minutes but can take far longer, so this is opt-in and bounded by the batch timeout setting.

| | |
|---|---|
| API surface | `POST/GET /v1/messages/batches · client.messages.batches.create/retrieve/results` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Cost | low: A few cents at most |

**Steps**

1. Create a one-request batch.
2. Poll every 10 seconds until it ends or the timeout passes.
3. Read the results.

**Expected result:** The batch ends and its one result succeeded with a text reply.

## Files API

Upload, reference, and delete files.

### TC-FILE-01

**Files API lifecycle (upload, use, delete)**

Checks the Files API end to end: upload a file once, reference it by file_id in a message, then delete it. Multipart uploads are where gateways most often differ from JSON requests (body size limits, content-type handling). Not offered on Vertex AI.

| | |
|---|---|
| API surface | `POST/GET/DELETE /v1/files · client.files.upload/retrieveMetadata/list/delete · document source.type file` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Cost | low: A few cents at most |

**Steps**

1. Upload a small text file containing an access phrase.
2. Read its metadata and list files.
3. Ask the model for the access phrase, referencing the file by file_id.
4. Delete the file and confirm it is gone.

**Expected result:** Every call succeeds, the answer contains GRANITE-OTTER, and the file is no longer retrievable afterwards.

## SDK behavior

Typed errors, timeouts, request IDs, and response headers.

### TC-SDK-01

**Typed error for an unknown model, without retry**

Checks the gateway returns errors the SDK can classify. Applications branch on the SDK's typed exceptions (NotFoundError, RateLimitError, …), and the SDK retries only 408/409/429/5xx; a gateway that turns client errors into 5xx makes the SDK retry requests that can never succeed.

| | |
|---|---|
| API surface | `POST /v1/messages · Anthropic.NotFoundError, retry policy` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | free: Free or no billable tokens |

**Steps**

1. Request a model that does not exist, with the SDK's default retries enabled.
2. Inspect the error type and count the HTTP attempts.

**Expected result:** An APIError subclass, ideally NotFoundError (404), after exactly one attempt.

### TC-SDK-02

**Typed error for an invalid request**

Checks a malformed request comes back as a 400 that the SDK maps to BadRequestError, with the API's explanation intact rather than replaced by a gateway error page.

| | |
|---|---|
| API surface | `POST /v1/messages · Anthropic.BadRequestError` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | free: Free or no billable tokens |

**Steps**

1. Send a request with an empty messages array.

**Expected result:** BadRequestError (400) with an invalid_request_error explanation.

### TC-SDK-03

**Request ID and rate-limit headers**

Checks response headers survive the gateway. The request-id header is what Anthropic support needs to trace a request; anthropic-ratelimit-* headers let applications pace themselves. Gateways often strip unknown response headers.

| | |
|---|---|
| API surface | `client.messages.create().withResponse() · response headers` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a request using withResponse() to get the raw HTTP response.
2. Record the response header names.

**Expected result:** A request ID, and on the Anthropic API, anthropic-ratelimit-* headers.

### TC-SDK-04

**Client timeout**

Checks the per-request timeout option raises the SDK's timeout error rather than hanging.

| | |
|---|---|
| API surface | `client.messages.create(params, { timeout }) · Anthropic.APIConnectionTimeoutError` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | free: Free or no billable tokens |

**Steps**

1. Send a request with a 1 ms timeout and retries off.

**Expected result:** APIConnectionTimeoutError.

## Beta features (anthropic-beta)

Features enabled by the anthropic-beta header, which gateways often strip.

### TC-BETA-01

**Compaction configuration accepted**

Checks the server-side compaction beta reaches the API. Compaction only fires once input passes its trigger (at least 50,000 tokens), so this verifies the beta header and configuration are accepted rather than paying to trigger a compaction.

| | |
|---|---|
| API surface | `POST /v1/messages · anthropic-beta: compact-2026-01-12 · context_management.edits compact_20260112` |
| anthropic-beta | `compact-2026-01-12` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-fable-5`, `claude-fable-5-1`, `claude-mythos-5`, `claude-mythos-5-1`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-opus-4-7`, `claude-opus-4-6`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-5-5` |
| Cost | low: A few cents at most |

**Steps**

1. Send a short request with a compaction edit and a 50,000-token trigger.

**Expected result:** HTTP 200. Without the beta header, the API rejects context_management as an unknown field.

### TC-BETA-02

**Context editing configuration accepted**

Checks the context editing beta, which clears old tool results from long conversations, reaches the API.

| | |
|---|---|
| API surface | `POST /v1/messages · anthropic-beta: context-management-2025-06-27 · clear_tool_uses_20250919` |
| anthropic-beta | `context-management-2025-06-27` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Cost | low: A few cents at most |

**Steps**

1. Send a request with a clear_tool_uses edit and a tool defined.

**Expected result:** HTTP 200.

### TC-BETA-03

**Cache diagnostics**

Checks the cache diagnostics beta. It is a clean test of header passthrough: with the header the response carries a diagnostics object; without it the request is rejected. Anthropic API only.

| | |
|---|---|
| API surface | `POST /v1/messages · anthropic-beta: cache-diagnosis-2026-04-07 · diagnostics` |
| anthropic-beta | `cache-diagnosis-2026-04-07` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Cost | low: A few cents at most |

**Steps**

1. Send a request with diagnostics.previous_message_id null.

**Expected result:** HTTP 200 with a diagnostics field in the response.

### TC-BETA-04

**Fast mode**

Checks fast mode (research preview), which runs the same model at higher output speed and premium price. Claude Opus 5.5, Opus 5, and Opus 4.8 on the Anthropic API only.

| | |
|---|---|
| API surface | `POST /v1/messages · anthropic-beta: fast-mode-2026-02-01 · speed: fast` |
| anthropic-beta | `fast-mode-2026-02-01` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Models documented to support it | `claude-opus-5`, `claude-opus-5-5`, `claude-opus-4-8` |
| Cost | low: A few cents at most |

**Steps**

1. Send a request with speed fast.

**Expected result:** HTTP 200 with usage.speed reported as fast.

### TC-BETA-05

**Task budget**

Checks task budgets, which give the model a token budget for an agentic task so it paces itself and finishes cleanly. Anthropic API only.

| | |
|---|---|
| API surface | `POST /v1/messages (stream) · anthropic-beta: task-budgets-2026-03-13 · output_config.task_budget` |
| anthropic-beta | `task-budgets-2026-03-13` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Models documented to support it | `claude-opus-5`, `claude-opus-5-5`, `claude-fable-5`, `claude-fable-5-1`, `claude-sonnet-5-5`, `claude-haiku-5-5`, `claude-opus-4-8`, `claude-opus-4-7` |
| Cost | low: A few cents at most |

**Steps**

1. Stream a request with a 20,000-token task budget (the minimum).

**Expected result:** HTTP 200 and a complete response.

### TC-BETA-06

**Thinking display: updates**

Checks the updates display mode, which hides reasoning but returns the model's progress notes between tool calls.

| | |
|---|---|
| API surface | `POST /v1/messages · anthropic-beta: thinking-display-updates-2026-08-18 · thinking.display updates` |
| anthropic-beta | `thinking-display-updates-2026-08-18` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-fable-5-1`, `claude-mythos-5-1`, `claude-fable-5`, `claude-opus-5-5`, `claude-sonnet-5-5` |
| Cost | low: A few cents at most |

**Steps**

1. Send a request with thinking adaptive and display updates.

**Expected result:** HTTP 200. Without the beta, updates is rejected as an unknown display value.

### TC-BETA-07

**Per-message effort**

Checks changing effort mid-conversation through a system message carrying output_config, which avoids invalidating the prompt cache.

| | |
|---|---|
| API surface | `POST /v1/messages · anthropic-beta: mid-conversation-output-config-2026-07-01 · { role: system, content: [], output_config }` |
| anthropic-beta | `mid-conversation-output-config-2026-07-01` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-fable-5-1`, `claude-mythos-5-1`, `claude-opus-5`, `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` |
| Cost | low: A few cents at most |

**Steps**

1. Send a user turn followed by an effort-only system message setting effort low.

**Expected result:** HTTP 200.

### TC-BETA-08

**Turn-scoped system message (clear_at)**

Checks a mid-conversation system message that applies for one turn only, used for per-turn reminders.

| | |
|---|---|
| API surface | `POST /v1/messages · anthropic-beta: mid-conversation-system-clear-at-2026-08-21 · clear_at: next_user_message` |
| anthropic-beta | `mid-conversation-system-clear-at-2026-08-21` |
| Anthropic API | Yes |
| Google Vertex AI | Yes |
| Models documented to support it | `claude-opus-5`, `claude-opus-5-5`, `claude-opus-4-8`, `claude-fable-5`, `claude-fable-5-1`, `claude-mythos-5`, `claude-mythos-5-1`, `claude-sonnet-5-5`, `claude-haiku-5-5` |
| Cost | low: A few cents at most |

**Steps**

1. Send a user turn followed by a system message with clear_at next_user_message.

**Expected result:** HTTP 200 with a reply that follows the instruction.

### TC-BETA-09

**Server-side refusal fallbacks**

Checks the server-side fallback parameter, which re-runs a refused request on a fallback model inside the same call. Anthropic API only; on other platforms the SDK's client-side middleware does this instead.

| | |
|---|---|
| API surface | `POST /v1/messages · anthropic-beta: server-side-fallback-2026-07-01 · fallbacks: default` |
| anthropic-beta | `server-side-fallback-2026-07-01` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Models documented to support it | `claude-fable-5-1`, `claude-opus-5-5`, `claude-opus-5`, `claude-sonnet-5-5` |
| Cost | low: A few cents at most |

**Steps**

1. Send an ordinary request with fallbacks default.

**Expected result:** HTTP 200 (no refusal is expected for an ordinary prompt; this verifies the parameter is accepted).

### TC-BETA-10

**MCP connector**

Checks the MCP connector, where Anthropic's servers connect to a remote MCP server on the model's behalf. Needs an MCP server URL that Anthropic can reach; skipped without one.

| | |
|---|---|
| API surface | `POST /v1/messages · anthropic-beta: mcp-client-2025-11-20 · mcp_servers + mcp_toolset` |
| anthropic-beta | `mcp-client-2025-11-20` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Needs | mcpServerUrl (target settings) |
| Cost | low: A few cents at most |

**Steps**

1. Declare the configured MCP server and its toolset.
2. Ask the model to list the server's tools.

**Expected result:** HTTP 200, ideally with MCP tool use or a list of the server's tools.

### TC-BETA-11

**Agent Skills (Anthropic xlsx skill)** · _opt-in_

Checks Agent Skills on the Messages API: an Anthropic-managed skill loaded into a code execution container produces a file. Comparatively expensive (container time plus generation), so opt-in. Generated files are deleted afterwards. Anthropic API only.

| | |
|---|---|
| API surface | `POST /v1/messages · anthropic-beta: code-execution-2025-08-25 · container.skills · code_execution_20260521` |
| anthropic-beta | `code-execution-2025-08-25` |
| Anthropic API | Yes |
| Google Vertex AI | Not offered |
| Cost | high: Comparatively expensive |

**Steps**

1. Load the xlsx skill into a container.
2. Ask for a one-cell spreadsheet.
3. Resume paused turns.
4. Delete any files produced.

**Expected result:** Code execution runs and a file is produced.
