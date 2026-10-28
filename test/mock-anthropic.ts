/**
 * A stand-in for the Anthropic API (and Vertex AI's rawPredict routes) behind a gateway. It answers
 * every request shape the test cases send with a scripted reply that satisfies the case, and
 * reproduces the gateway faults the tool is meant to detect, each behind a switch.
 *
 * It behaves like claude-opus-5-5 on API version 2026-10-21: sampling parameters, forced tool use,
 * and budget_tokens are rejected with a 400, as the real API does.
 */
import { createHash, randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockOptions {
  /** Which credential the gateway accepts. Omit to accept anything. */
  auth?: { header: string; value: string };
  /** Answer the Vertex AI rawPredict routes instead of /v1/messages. */
  dialect?: "anthropic" | "vertex";
  /** Gateway buffers server-sent events and releases them at the end. */
  bufferSse?: boolean;
  /** Gateway drops the anthropic-beta request header. */
  stripBeta?: boolean;
  /** Gateway rewrites anthropic-version to this value. */
  pinVersion?: string;
  /** Gateway strips request-id and rate-limit response headers. */
  stripResponseHeaders?: boolean;
  /** Path prefixes the gateway does not route (404), e.g. ["/v1/files"]. */
  unrouted?: string[];
  /** Port to listen on. Default: any free port. */
  port?: number;
  /** Delay between streamed events, ms. */
  eventDelayMs?: number;
}

export interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface Mock {
  url: string;
  requests: RecordedRequest[];
  options: MockOptions;
  close(): Promise<void>;
}

type Json = Record<string, any>;
type Block = Json & { type: string };

const MODEL = "claude-opus-5-5";
const SIGNING_SALT = randomBytes(8).toString("hex");
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "claude-opus-5", "claude-sonnet-5", "claude-opus-4-8"];
/** Time to first byte for model calls. Real models are never faster than this. */
const MODEL_LATENCY_MS = 15;
const CITIES = ["Paris", "Tokyo", "Oslo", "Lisbon", "Rome", "London"];

const BETA_FIELDS: [string, (b: Json) => boolean, string][] = [
  ["context_management", (b) => Boolean(b.context_management?.edits?.some((e: Json) => e.type?.startsWith("compact_"))), "compact-2026-01-12"],
  ["context_management", (b) => Boolean(b.context_management?.edits?.some((e: Json) => e.type?.startsWith("clear_"))), "context-management-2025-06-27"],
  ["diagnostics", (b) => "diagnostics" in b, "cache-diagnosis-2026-04-07"],
  ["speed", (b) => "speed" in b, "fast-mode-2026-02-01"],
  ["output_config.task_budget", (b) => Boolean(b.output_config?.task_budget), "task-budgets-2026-03-13"],
  ["fallbacks", (b) => "fallbacks" in b, "server-side-fallback-2026-07-01"],
  ["mcp_servers", (b) => "mcp_servers" in b, "mcp-client-2025-11-20"],
  ["container", (b) => Boolean(b.container?.skills), "code-execution-2025-08-25"],
  ["messages.output_config", (b) => b.messages?.some((m: Json) => m.role === "system" && m.output_config), "mid-conversation-output-config-2026-07-01"],
  ["messages.clear_at", (b) => b.messages?.some((m: Json) => m.role === "system" && m.clear_at), "mid-conversation-system-clear-at-2026-08-21"],
];

class HttpError extends Error {
  constructor(
    public status: number,
    public type: string,
    message: string,
  ) {
    super(message);
  }
}

export async function startMock(options: MockOptions = {}): Promise<Mock> {
  const requests: RecordedRequest[] = [];
  const cache = new Set<string>();
  const files = new Map<string, { id: string; filename: string; mime_type: string; size_bytes: number; text: string; created_at: string }>();
  const batches = new Map<string, Json>();
  let seq = 0;

  const server: Server = createServer(async (req, res) => {
    const id = `req_mock${String(++seq).padStart(6, "0")}`;
    const url = new URL(req.url ?? "/", "http://mock");
    const raw = await readBody(req);
    const contentType = String(req.headers["content-type"] ?? "");
    let body: any;
    if (contentType.includes("application/json") && raw.length) {
      try {
        body = JSON.parse(raw.toString("utf8"));
      } catch {
        body = undefined;
      }
    }
    const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(", ") : String(v ?? "")]));
    if (options.stripBeta) delete headers["anthropic-beta"];
    if (options.pinVersion && headers["anthropic-version"]) headers["anthropic-version"] = options.pinVersion;
    requests.push({ method: req.method ?? "GET", path: url.pathname + url.search, headers, body });

    const send = (status: number, payload: unknown, extra: Record<string, string> = {}) => {
      res.writeHead(status, { "content-type": "application/json", ...responseHeaders(id), ...extra });
      res.end(JSON.stringify(payload));
    };
    const responseHeaders = (rid: string): Record<string, string> =>
      options.stripResponseHeaders
        ? {}
        : options.dialect === "vertex"
          ? { "request-id": rid }
          : {
              "request-id": rid,
              "anthropic-ratelimit-requests-limit": "4000",
              "anthropic-ratelimit-requests-remaining": "3999",
              "anthropic-ratelimit-tokens-limit": "2000000",
            };

    try {
      if (options.auth && headers[options.auth.header.toLowerCase()] !== options.auth.value) {
        throw new HttpError(401, "authentication_error", "Access denied due to missing or invalid subscription key.");
      }
      if (options.unrouted?.some((p) => url.pathname.includes(p))) throw new HttpError(404, "not_found_error", "Resource not found");

      const p = url.pathname;
      const vertex = p.match(/\/projects\/[^/]+\/locations\/[^/]+\/publishers\/anthropic\/models\/([^/:]+):(rawPredict|streamRawPredict)$/);
      if (options.dialect === "vertex") {
        if (!vertex || req.method !== "POST") throw new HttpError(404, "not_found_error", `No route for ${req.method} ${p}`);
        const version = body?.anthropic_version;
        if (!version) throw new HttpError(400, "invalid_request_error", "anthropic_version: field required");
        const versionSent = options.pinVersion ?? version;
        if (vertex[1] === "count-tokens") return send(200, { input_tokens: inputTokens(body) });
        await sleep(MODEL_LATENCY_MS);
        const msg = { ...body, model: vertex[1] };
        const beta = headers["anthropic-beta"] ?? "";
        const out = respond(msg, versionSent, beta);
        if (msg.stream) return stream(res, out, id);
        return send(200, out);
      }

      const version = headers["anthropic-version"] ?? "2023-06-01";
      const beta = headers["anthropic-beta"] ?? "";

      if (req.method === "POST" && p.endsWith("/v1/messages")) {
        await sleep(MODEL_LATENCY_MS);
        const out = respond(body ?? {}, version, beta);
        if (body?.stream) return stream(res, out, id);
        return send(200, out);
      }
      if (req.method === "POST" && p.endsWith("/v1/messages/count_tokens")) return send(200, { input_tokens: inputTokens(body ?? {}) });

      const model = p.match(/\/v1\/models\/([^/]+)$/);
      if (req.method === "GET" && model) {
        if (!MODELS.includes(decodeURIComponent(model[1]))) throw new HttpError(404, "not_found_error", `model: ${model[1]}`);
        return send(200, modelInfo(decodeURIComponent(model[1])));
      }
      if (req.method === "GET" && p.endsWith("/v1/models")) {
        const limit = Number(url.searchParams.get("limit") ?? 20);
        const after = url.searchParams.get("after_id");
        const start = after ? MODELS.indexOf(after) + 1 : 0;
        const data = MODELS.slice(start, start + limit).map(modelInfo);
        return send(200, { data, has_more: start + limit < MODELS.length, first_id: data[0]?.id ?? null, last_id: data.at(-1)?.id ?? null });
      }

      const batch = p.match(/\/v1\/messages\/batches(?:\/([^/]+))?(?:\/(cancel|results))?$/);
      if (batch) {
        const [, bid, action] = batch;
        if (req.method === "POST" && !bid) {
          const b = {
            id: `msgbatch_${randomBytes(8).toString("hex")}`,
            type: "message_batch",
            processing_status: "in_progress",
            request_counts: { processing: body.requests.length, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
            created_at: new Date().toISOString(),
            expires_at: new Date(Date.now() + 86_400_000).toISOString(),
            ended_at: null,
            cancel_initiated_at: null,
            archived_at: null,
            results_url: null,
            _requests: body.requests,
          };
          batches.set(b.id, b);
          return send(200, publicBatch(b));
        }
        if (req.method === "GET" && !bid) return send(200, { data: [...batches.values()].reverse().map(publicBatch), has_more: false, first_id: null, last_id: null });
        const b = batches.get(bid);
        if (!b) throw new HttpError(404, "not_found_error", `batch ${bid} not found`);
        if (req.method === "POST" && action === "cancel") {
          b.processing_status = "canceling";
          b.cancel_initiated_at = new Date().toISOString();
          return send(200, publicBatch(b));
        }
        if (req.method === "GET" && action === "results") {
          const lines = (b._requests as Json[]).map((r) => JSON.stringify({ custom_id: r.custom_id, result: { type: "succeeded", message: respond(r.params, version, "") } }));
          res.writeHead(200, { "content-type": "application/x-jsonl", ...responseHeaders(id) });
          return res.end(lines.join("\n"));
        }
        if (req.method === "GET") {
          b.processing_status = "ended";
          b.ended_at = new Date().toISOString();
          b.results_url = `${url.origin}${p}/results`;
          return send(200, publicBatch(b));
        }
      }

      const file = p.match(/\/v1\/files(?:\/([^/]+))?$/);
      if (file) {
        const [, fid] = file;
        if (req.method === "POST" && !fid) {
          const form = await new Response(new Uint8Array(raw), { headers: { "content-type": contentType } }).formData();
          const f = form.get("file") as File;
          const text = Buffer.from(await f.arrayBuffer()).toString("utf8");
          const entry = { id: `file_${randomBytes(8).toString("hex")}`, type: "file", filename: f.name, mime_type: f.type || "text/plain", size_bytes: f.size, text, created_at: new Date().toISOString() };
          files.set(entry.id, entry);
          return send(200, publicFile(entry));
        }
        if (req.method === "GET" && !fid) return send(200, { data: [...files.values()].map(publicFile), has_more: false, first_id: null, last_id: null });
        const f = files.get(fid);
        if (!f) throw new HttpError(404, "not_found_error", `file ${fid} not found`);
        if (req.method === "GET") return send(200, publicFile(f));
        if (req.method === "DELETE") {
          files.delete(fid);
          return send(200, { id: fid, type: "file_deleted" });
        }
      }

      throw new HttpError(404, "not_found_error", `No route for ${req.method} ${p}`);
    } catch (err) {
      if (err instanceof HttpError) return send(err.status, { type: "error", error: { type: err.type, message: err.message }, request_id: id });
      return send(500, { type: "error", error: { type: "api_error", message: String(err) } });
    }
  });

  /** The model. Validates like the real API, then composes a scripted reply. */
  function respond(body: Json, version: string, betaHeader: string): Json {
    const betas = new Set(betaHeader.split(",").map((s) => s.trim()).filter(Boolean));
    if (!Array.isArray(body.messages) || body.messages.length === 0) throw new HttpError(400, "invalid_request_error", "messages: at least one message is required");
    if (body.model !== undefined && !MODELS.includes(body.model)) throw new HttpError(404, "not_found_error", `model: ${body.model}`);
    for (const [field, present, needed] of BETA_FIELDS) {
      if (present(body) && !betas.has(needed)) throw new HttpError(400, "invalid_request_error", `${field}: Extra inputs are not permitted`);
    }
    if (body.thinking?.display === "updates" && !betas.has("thinking-display-updates-2026-08-18")) {
      throw new HttpError(400, "invalid_request_error", "thinking.display: 'updates' is not a valid value");
    }
    if (version >= "2026-10-21") {
      for (const k of ["temperature", "top_p", "top_k"]) {
        if (k in body) throw new HttpError(400, "invalid_request_error", `${k}: sampling parameters are not supported on API version ${version}`);
      }
    }
    if (body.tool_choice && ["any", "tool"].includes(body.tool_choice.type)) {
      throw new HttpError(400, "invalid_request_error", `tool_choice.type '${body.tool_choice.type}' is not supported on this model`);
    }
    if (body.thinking?.type === "enabled") throw new HttpError(400, "invalid_request_error", "thinking.type 'enabled' is not supported on this model; use adaptive thinking");
    for (const m of body.messages as Json[]) {
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const b of m.content as Block[]) {
        if (b.type === "thinking" && b.signature !== sign(b.thinking)) throw new HttpError(400, "invalid_request_error", "Invalid `signature` in `thinking` block");
      }
    }

    const content = compose(body);
    let stop_reason = content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
    let stop_sequence: string | null = null;

    for (const b of content) {
      if (b.type !== "text") continue;
      for (const s of (body.stop_sequences as string[] | undefined) ?? []) {
        const i = b.text.indexOf(s);
        if (i >= 0) {
          b.text = b.text.slice(0, i);
          stop_reason = "stop_sequence";
          stop_sequence = s;
        }
      }
      const words = b.text.split(/(?<=\s)/);
      if (words.length > body.max_tokens) {
        b.text = words.slice(0, body.max_tokens).join("");
        stop_reason = "max_tokens";
      }
    }

    const effortExtra = { low: 0, medium: 20, high: 60, xhigh: 90, max: 120 }[body.output_config?.effort as string] ?? 20;
    const output = Math.min(body.max_tokens, content.reduce((n, b) => n + est(JSON.stringify(b)), 0) + effortExtra);
    const usage: Json = { input_tokens: inputTokens(body), output_tokens: output, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
    const cached = cacheableText(body);
    if (cached) {
      const key = hash(cached);
      const tokens = est(cached);
      if (cache.has(key)) usage.cache_read_input_tokens = tokens;
      else {
        cache.add(key);
        usage.cache_creation_input_tokens = tokens;
      }
      usage.input_tokens = Math.max(1, usage.input_tokens - tokens);
    }
    if (body.speed) usage.speed = body.speed;
    const msg: Json = { id: `msg_${randomBytes(10).toString("hex")}`, type: "message", role: "assistant", model: body.model ?? MODEL, content, stop_reason, stop_sequence, usage };
    if ("diagnostics" in body) msg.diagnostics = { cache_miss_reason: null };
    return msg;
  }

  async function stream(res: ServerResponse, msg: Json, rid: string): Promise<void> {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", ...(options.stripResponseHeaders ? {} : { "request-id": rid }) });
    let closed = false;
    res.on("close", () => (closed = true));
    const delay = options.eventDelayMs ?? 2;
    const buffered: string[] = [];
    const emit = async (type: string, data: Json) => {
      const chunk = `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
      if (options.bufferSse) buffered.push(chunk);
      else if (!closed) {
        res.write(chunk);
        await sleep(delay);
      }
    };

    await emit("message_start", { message: { ...msg, content: [], stop_reason: null, stop_sequence: null, usage: { ...msg.usage, output_tokens: 1 } } });
    for (const [index, block] of (msg.content as Block[]).entries()) {
      if (closed) return;
      if (block.type === "text") {
        await emit("content_block_start", { index, content_block: { type: "text", text: "", ...(block.citations ? { citations: [] } : {}) } });
        for (const piece of pieces(block.text, 6)) await emit("content_block_delta", { index, delta: { type: "text_delta", text: piece } });
        for (const c of block.citations ?? []) await emit("content_block_delta", { index, delta: { type: "citations_delta", citation: c } });
      } else if (block.type === "thinking") {
        await emit("content_block_start", { index, content_block: { type: "thinking", thinking: "", signature: "" } });
        for (const piece of pieces(block.thinking, 12)) await emit("content_block_delta", { index, delta: { type: "thinking_delta", thinking: piece } });
        await emit("content_block_delta", { index, delta: { type: "signature_delta", signature: block.signature } });
      } else if (block.type === "tool_use" || block.type === "server_tool_use") {
        await emit("content_block_start", { index, content_block: { ...block, input: {} } });
        for (const piece of pieces(JSON.stringify(block.input), 6)) await emit("content_block_delta", { index, delta: { type: "input_json_delta", partial_json: piece } });
      } else {
        await emit("content_block_start", { index, content_block: block });
      }
      await emit("content_block_stop", { index });
    }
    await emit("message_delta", { delta: { stop_reason: msg.stop_reason, stop_sequence: msg.stop_sequence }, usage: { output_tokens: msg.usage.output_tokens } });
    await emit("message_stop", {});
    if (options.bufferSse) {
      await sleep(delay * buffered.length);
      if (!closed) res.write(buffered.join(""));
    }
    res.end();
  }

  /** Composes the reply. The rules are keyed on the prompts the test cases send. */
  function compose(body: Json): Block[] {
    const messages = body.messages as Json[];
    const conversation = messages.filter((m) => m.role !== "system");
    const last = conversation.at(-1) ?? { content: "" };
    const lastText = textIn(last.content);
    const systemText = textIn(body.system ?? "");
    const midSystem = messages.filter((m) => m.role === "system").map((m) => textIn(m.content)).join(" ");
    const tools = (body.tools as Json[] | undefined) ?? [];
    const out: Block[] = [];

    if (body.thinking?.type === "adaptive") {
      const thinking = body.thinking.display === "summarized" ? "Let x be the ball. x + (x + 1.00) = 1.10, so x = 0.05." : "";
      out.push({ type: "thinking", thinking, signature: sign(thinking) });
    }

    const results = Array.isArray(last.content) ? (last.content as Block[]).filter((b) => b.type === "tool_result") : [];
    if (results.length) {
      const parts = results.map((r) => (r.is_error ? `The tool returned an error and I was unable to get the data: ${textIn(r.content)}` : textIn(r.content)));
      return [...out, text(`Here is what I found. ${parts.join(" ")}`)];
    }

    const server = tools.find((t) => /^(web_search|web_fetch|code_execution|tool_search_tool)/.test(String(t.type)));
    if (server) {
      const blocks = serverTool(String(server.type), lastText);
      if (body.container?.skills) {
        const id = `file_${randomBytes(8).toString("hex")}`;
        files.set(id, { id, filename: "probe.xlsx", mime_type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", size_bytes: 1, text: "", created_at: new Date().toISOString() });
        (blocks[1].content as Json).content = [{ type: "bash_code_execution_output", file_id: id }];
      }
      return [...out, ...blocks];
    }

    const clientTools = tools.filter((t) => !t.type || t.type === "custom" || /^(text_editor|bash|memory)_/.test(t.type));
    if (clientTools.length && body.tool_choice?.type !== "none" && wantsTool(lastText, clientTools)) {
      return [...out, ...callTools(clientTools, lastText, Boolean(body.tool_choice?.disable_parallel_tool_use))];
    }

    const schema = body.output_config?.format?.schema;
    if (body.output_config?.format?.type === "json_schema" && schema) return [...out, text(JSON.stringify(fromSchema(schema)))];

    const doc = documents(conversation);
    const citing = doc.find((d) => d.citations?.enabled);
    if (citing) {
      const sentence = String(citing.source.data).split(/(?<=\.)\s/).find((s) => /located/.test(s)) ?? String(citing.source.data);
      const place = sentence.match(/located in (\w+)/)?.[1] ?? "";
      const start = String(citing.source.data).indexOf(sentence);
      return [
        ...out,
        text("According to the note, "),
        { type: "text", text: `the facility is located in ${place}.`, citations: [{ type: "char_location", cited_text: sentence, document_index: 0, document_title: citing.title ?? null, start_char_index: start, end_char_index: start + sentence.length }] },
      ];
    }

    return [...out, text(answer({ lastText, systemText, midSystem, conversation, doc }))];
  }

  function answer(c: { lastText: string; systemText: string; midSystem: string; conversation: Json[]; doc: Json[] }): string {
    const exact = c.systemText.match(/reply with exactly the single word: (\w+)/i);
    if (exact) return exact[1];
    if (/french/i.test(c.midSystem)) return "Bonjour ! Le jour après lundi est mardi.";
    if (/three words/i.test(c.midSystem)) return "Vast, deep, blue.";
    const literal = c.lastText.match(/Reply with exactly: (\S+)/);
    if (literal) return literal[1];
    const repeat = c.lastText.match(/Repeat exactly this text and nothing else: (.*)$/);
    if (repeat) return repeat[1];
    if (/what number did I ask you to remember/i.test(c.lastText)) return c.conversation.map((m) => textIn(m.content)).join(" ").match(/\b\d{3,}\b/)?.[0] ?? "I don't know.";
    if (/codeword|access phrase/i.test(c.lastText)) {
      const corpus = c.doc.map(docText).join(" ");
      return corpus.match(/\b[A-Z]{3,}-[A-Z0-9]{2,}\b/)?.[0] ?? "I could not find one.";
    }
    if (/what color/i.test(c.lastText)) return "Red.";
    if (/describe this image/i.test(c.lastText)) return "Two red dice resting on a white surface.";
    if (/bat and a ball/i.test(c.lastText)) return "$0.05";
    const count = c.lastText.match(/Count from 1 to (\d+)/);
    if (count) return Array.from({ length: Number(count[1]) }, (_, i) => i + 1).join(/one number per line/.test(c.lastText) ? "\n" : ", ");
    if (/three colors/i.test(c.lastText)) return "red, green, blue";
    const words = c.lastText.match(/(\d+)-word/);
    if (words) return Array.from({ length: Number(words[1]) }, (_, i) => ["the", "river", "keeper", "light", "slowly", "turned"][i % 6]).join(" ");
    if (/sentence about the sea/i.test(c.lastText)) return "The sea keeps its own time, patient and enormous.";
    if (/task budget/i.test(c.lastText)) return "A task budget tells the model how many tokens it may spend on a task. It lets the model pace its work and finish cleanly.";
    if (/list the tools/i.test(c.lastText)) return "The MCP server offers: echo, add.";
    return "OK";
  }

  function serverTool(type: string, prompt: string): Block[] {
    const id = `srvtoolu_${randomBytes(8).toString("hex")}`;
    if (type.startsWith("web_search")) {
      return [
        { type: "server_tool_use", id, name: "web_search", input: { query: "official Anthropic website" } },
        { type: "web_search_tool_result", tool_use_id: id, content: [{ type: "web_search_result", url: "https://www.anthropic.com", title: "Anthropic", encrypted_content: "enc", page_age: null }] },
        text("The official website is https://www.anthropic.com."),
      ];
    }
    if (type.startsWith("web_fetch")) {
      const url = prompt.match(/https?:\/\/\S+/)?.[0] ?? "https://example.com";
      return [
        { type: "server_tool_use", id, name: "web_fetch", input: { url } },
        { type: "web_fetch_tool_result", tool_use_id: id, content: { type: "web_fetch_result", url, retrieved_at: new Date().toISOString(), content: { type: "document", source: { type: "text", media_type: "text/plain", data: "Example Domain" }, title: "Example Domain" } } },
        text("The main heading is Example Domain."),
      ];
    }
    if (type.startsWith("code_execution")) {
      return [
        { type: "server_tool_use", id, name: "bash_code_execution", input: { command: "python3 -c 'print(sum(i*i for i in range(1,101)))'" } },
        { type: "bash_code_execution_tool_result", tool_use_id: id, content: { type: "bash_code_execution_result", stdout: "338350\n", stderr: "", return_code: 0, content: [] } },
        text("338350"),
      ];
    }
    const city = CITIES.find((c) => prompt.includes(c)) ?? "Oslo";
    return [
      { type: "server_tool_use", id, name: "tool_search_tool_bm25", input: { query: "weather" } },
      { type: "tool_search_tool_result", tool_use_id: id, content: { type: "tool_search_tool_search_result", tool_references: [{ type: "tool_reference", tool_name: "get_weather" }] } },
      { type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name: "get_weather", input: { city } },
    ];
  }

  return new Promise((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        options,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });

  function documents(conversation: Json[]): Json[] {
    return conversation.flatMap((m) => (Array.isArray(m.content) ? (m.content as Block[]).filter((b) => b.type === "document") : []));
  }

  function docText(d: Json): string {
    const s = d.source ?? {};
    if (s.type === "text") return String(s.data);
    if (s.type === "base64") return Buffer.from(String(s.data), "base64").toString("latin1");
    if (s.type === "file") return files.get(s.file_id)?.text ?? "";
    return "";
  }
}

function wantsTool(prompt: string, tools: Json[]): boolean {
  if (tools.some((t) => /^(memory|text_editor|bash)_/.test(String(t.type)))) return true;
  return tools.some((t) => prompt.includes(t.name)) || /weather|codeword|book a table/i.test(prompt);
}

function callTools(tools: Json[], prompt: string, single: boolean): Block[] {
  const call = (name: string, input: Json): Block => ({ type: "tool_use", id: `toolu_${randomBytes(8).toString("hex")}`, name, input });
  const memory = tools.find((t) => String(t.type).startsWith("memory_"));
  if (memory) return [text("Let me check my memory directory first."), call(memory.name, { command: "view", path: "/memories" })];
  const editor = tools.find((t) => String(t.type).startsWith("text_editor_"));
  if (editor) return [call(editor.name, { command: "view", path: prompt.match(/\/\S+?(?=\.?$|\s)/)?.[0] ?? "/repo/README.md" })];
  const tool = tools.find((t) => prompt.includes(t.name)) ?? tools.find((t) => /weather/i.test(prompt) && t.name === "get_weather") ?? tools[0];
  const cities = CITIES.filter((c) => prompt.includes(c));
  if (tool.name === "get_weather" && cities.length > 1 && !single) return cities.map((city) => call("get_weather", { city }));
  return [call(tool.name, fromSchema(tool.input_schema ?? { type: "object", properties: {} }, prompt) as Json)];
}

/** A value that satisfies a JSON schema, using the prompt where it helps. */
function fromSchema(schema: Json, prompt = "", key = ""): unknown {
  if (schema.enum) {
    const hit = schema.enum.find((v: unknown) => new RegExp(`\\b${String(v)}`, "i").test(prompt));
    return hit ?? schema.enum[0];
  }
  switch (schema.type) {
    case "object":
      return Object.fromEntries(Object.entries((schema.properties ?? {}) as Record<string, Json>).map(([k, s]) => [k, fromSchema(s, prompt, k)]));
    case "array":
      return [];
    case "boolean":
      return true;
    case "integer":
      return Number(prompt.match(/\b\d+\b/)?.[0] ?? 1);
    case "number":
      return key.includes("population") ? 37.4 : 1.5;
    default: {
      const known: Record<string, string> = { city: CITIES.find((c) => prompt.includes(c)) ?? "Paris", country: "France", name: "Tokyo", ticker: "ANTH" };
      if (known[key]) return known[key];
      return prompt.match(/\bat ([A-Z]\w+(?: [A-Z]\w+)*)/)?.[1] ?? "example";
    }
  }
}

function text(t: string): Block {
  return { type: "text", text: t };
}

function textIn(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b: Json) => (b.type === "text" ? b.text : b.type === "tool_result" ? textIn(b.content) : "")).join(" ");
}

function cacheableText(body: Json): string | undefined {
  const sys = body.system;
  if (Array.isArray(sys) && sys.some((b: Json) => b.cache_control)) return sys.map((b: Json) => b.text).join("\n");
  if (body.cache_control && sys) return textIn(sys);
  return undefined;
}

function inputTokens(body: Json): number {
  return Math.max(1, est(JSON.stringify({ system: body.system, messages: body.messages, tools: body.tools })));
}

const est = (s: string) => Math.ceil(s.length / 4);
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const sign = (thinking: string) => createHash("sha256").update(SIGNING_SALT + thinking).digest("base64");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function pieces(s: string, n: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
  return out.length ? out : [""];
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function modelInfo(id: string): Json {
  return {
    type: "model",
    id,
    display_name: id.replace(/^claude-/, "Claude ").replace(/-/g, " "),
    created_at: "2026-06-01T00:00:00Z",
    max_input_tokens: 1_000_000,
    max_tokens: 128_000,
    capabilities: {
      effort: { supported: true },
      image_input: { supported: true },
      structured_outputs: { supported: true },
      thinking: { types: { adaptive: { supported: true }, enabled: { supported: false } } },
      context_management: { compact_20260112: { supported: true } },
    },
  };
}

function publicBatch(b: Json): Json {
  const { _requests, ...rest } = b;
  return rest;
}

function publicFile(f: Json): Json {
  const { text: _text, ...rest } = f;
  return { ...rest, type: "file", downloadable: false };
}
