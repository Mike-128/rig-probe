/**
 * Evidence capture. Wraps the fetch the SDK uses so every HTTP exchange is recorded exactly as
 * sent and received: method, URL, headers, body, status, timing, and for streams the arrival time
 * of each network chunk. Secrets are redacted at capture time, so they never reach memory that
 * gets written to disk.
 */

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface StreamTiming {
  /** Network chunks received. A gateway that buffers delivers everything in one or two. */
  chunkCount: number;
  /** SSE events parsed out of the body. */
  eventCount: number;
  eventTypes: string[];
  firstChunkMs: number | null;
  lastChunkMs: number | null;
  /** Milliseconds between the first and last chunk: near zero on a buffered stream. */
  spreadMs: number | null;
}

export interface Exchange {
  seq: number;
  label?: string;
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  status?: number;
  statusText?: string;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  stream?: StreamTiming;
  usage?: Usage;
  startedAt: string;
  ttfbMs?: number;
  durationMs?: number;
  error?: string;
}

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
  "ocp-apim-subscription-key",
  "x-goog-api-key",
  "cookie",
  "set-cookie",
]);
const SENSITIVE_NAME = /key|token|secret|auth|signature|password|cookie|credential|subscription/i;
const MAX_STRING = 4000;
const MAX_RAW_SSE = 200_000;

export interface RecorderOptions {
  /** Literal secret values. Any occurrence anywhere is replaced. */
  secrets: string[];
  /** Extra header names to treat as sensitive (e.g. the configured auth header). */
  sensitiveHeaders?: string[];
  baseFetch?: typeof fetch;
}

export interface Recorder {
  fetch: typeof fetch;
  /** Labels the exchanges that follow, e.g. "attempt 2: X-Api-Key". */
  setLabel(label?: string): void;
  /** Exchanges so far, with stream timing finalized. Safe to call while streams are open. */
  snapshot(): Exchange[];
}

export function createRecorder(opts: RecorderOptions): Recorder {
  const secrets = opts.secrets.filter((s) => s && s.length >= 4);
  const sensitive = new Set([...SENSITIVE_HEADERS, ...(opts.sensitiveHeaders ?? []).map((h) => h.toLowerCase())]);
  const baseFetch = opts.baseFetch ?? globalThis.fetch.bind(globalThis);
  const exchanges: Exchange[] = [];
  const streams = new Map<Exchange, { raw: string; chunkTimes: number[] }>();
  let label: string | undefined;
  let seq = 0;

  const scrub = (s: string): string => {
    let out = s;
    for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join(redacted(secret));
    return out;
  };

  const redactHeaders = (h: Headers): Record<string, string> => {
    const out: Record<string, string> = {};
    h.forEach((value, name) => {
      const lower = name.toLowerCase();
      if (sensitive.has(lower) || (SENSITIVE_NAME.test(lower) && lower !== "anthropic-version" && lower !== "anthropic-beta")) {
        out[name] = value ? redacted(value) : "";
      } else {
        out[name] = scrub(value);
      }
    });
    return out;
  };

  const redactUrl = (raw: string): string => {
    try {
      const u = new URL(raw);
      for (const [k] of [...u.searchParams]) if (SENSITIVE_NAME.test(k)) u.searchParams.set(k, "[REDACTED]");
      return scrub(u.toString());
    } catch {
      return scrub(raw);
    }
  };

  const recorderFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const ex: Exchange = {
      seq: ++seq,
      label,
      method,
      url: redactUrl(url),
      requestHeaders: redactHeaders(headers),
      requestBody: describeBody(init?.body, scrub),
      startedAt: new Date().toISOString(),
    };
    exchanges.push(ex);
    const t0 = performance.now();
    let res: Response;
    try {
      res = await baseFetch(input as RequestInfo, init);
    } catch (err) {
      ex.durationMs = Math.round(performance.now() - t0);
      ex.error = scrub(err instanceof Error ? `${err.name}: ${err.message}` : String(err));
      throw err;
    }
    ex.ttfbMs = Math.round(performance.now() - t0);
    ex.status = res.status;
    ex.statusText = res.statusText;
    ex.responseHeaders = redactHeaders(res.headers);
    const contentType = res.headers.get("content-type") ?? "";

    if (contentType.includes("text/event-stream") && res.body) {
      const state = { raw: "", chunkTimes: [] as number[] };
      streams.set(ex, state);
      const decoder = new TextDecoder();
      const tap = new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          state.chunkTimes.push(Math.round(performance.now() - t0));
          if (state.raw.length < MAX_RAW_SSE) state.raw += decoder.decode(chunk, { stream: true });
          controller.enqueue(chunk);
        },
        flush() {
          ex.durationMs = Math.round(performance.now() - t0);
        },
      });
      return new Response(res.body.pipeThrough(tap), { status: res.status, statusText: res.statusText, headers: res.headers });
    }

    if (contentType.includes("json") || contentType.startsWith("text/")) {
      const text = await res.clone().text();
      ex.durationMs = Math.round(performance.now() - t0);
      let parsed: unknown = text;
      try {
        parsed = text ? JSON.parse(text) : "";
      } catch {
        /* keep as text */
      }
      ex.responseBody = sanitize(parsed, scrub);
      ex.usage = usageFrom(parsed);
    } else {
      ex.durationMs = Math.round(performance.now() - t0);
      ex.responseBody = `<${contentType || "binary"} body, ${res.headers.get("content-length") ?? "unknown"} bytes, not captured>`;
    }
    return res;
  };

  return {
    fetch: recorderFetch as typeof fetch,
    setLabel(next) {
      label = next;
    },
    snapshot() {
      for (const [ex, state] of streams) finalizeStream(ex, state, scrub);
      return exchanges.map((e) => ({ ...e }));
    },
  };
}

function finalizeStream(ex: Exchange, state: { raw: string; chunkTimes: number[] }, scrub: (s: string) => string): void {
  const events = parseSse(state.raw);
  const times = state.chunkTimes;
  ex.stream = {
    chunkCount: times.length,
    eventCount: events.length,
    eventTypes: events.map((e) => e.event ?? (isObj(e.data) ? String(e.data.type) : "message")).slice(0, 400),
    firstChunkMs: times[0] ?? null,
    lastChunkMs: times.at(-1) ?? null,
    spreadMs: times.length ? times.at(-1)! - times[0] : null,
  };
  // Usage arrives in message_start (input side) and message_delta (output side, cumulative).
  const usage: Usage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
  let seen = false;
  for (const e of events) {
    if (!isObj(e.data)) continue;
    const u = e.data.type === "message_start" && isObj(e.data.message) ? e.data.message.usage : e.data.type === "message_delta" ? e.data.usage : undefined;
    if (!isObj(u)) continue;
    seen = true;
    for (const k of Object.keys(usage) as (keyof Usage)[]) if (typeof u[k] === "number") usage[k] = u[k] as number;
  }
  if (seen) ex.usage = usage;
  // Keep a readable, bounded copy of the stream as evidence.
  ex.responseBody = {
    sse: events.slice(0, 60).map((e) => sanitize(e.data, scrub)),
    omittedEvents: Math.max(0, events.length - 60),
  };
}

/**
 * The redaction marker. The last four characters help tell keys apart in evidence, but only on
 * values long enough that four characters reveal nothing useful.
 */
export function redacted(value: string): string {
  return value.length >= 16 ? `[REDACTED …${value.slice(-4)}]` : "[REDACTED]";
}

export function parseSse(raw: string): { event?: string; data: unknown }[] {
  const out: { event?: string; data: unknown }[] = [];
  for (const block of raw.split(/\r?\n\r?\n/)) {
    let event: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (!dataLines.length) continue;
    const joined = dataLines.join("\n");
    let data: unknown = joined;
    try {
      data = JSON.parse(joined);
    } catch {
      /* keep raw */
    }
    out.push({ event, data });
  }
  return out;
}

function usageFrom(body: unknown): Usage | undefined {
  if (!isObj(body) || !isObj(body.usage)) return undefined;
  const u = body.usage;
  return {
    input_tokens: num(u.input_tokens),
    output_tokens: num(u.output_tokens),
    cache_creation_input_tokens: num(u.cache_creation_input_tokens),
    cache_read_input_tokens: num(u.cache_read_input_tokens),
  };
}

function describeBody(body: BodyInit | null | undefined, scrub: (s: string) => string): unknown {
  if (body == null) return undefined;
  if (typeof body === "string") {
    try {
      return sanitize(JSON.parse(body), scrub);
    } catch {
      return truncate(scrub(body));
    }
  }
  if (body instanceof FormData) {
    const parts: Record<string, string> = {};
    body.forEach((v, k) => {
      parts[k] = typeof v === "string" ? truncate(scrub(v)) : `<file ${(v as File).name ?? "blob"}, ${(v as Blob).size} bytes, ${(v as Blob).type || "unknown type"}>`;
    });
    return { multipart: parts };
  }
  if (body instanceof ArrayBuffer || ArrayBuffer.isView(body)) return `<binary body, ${(body as ArrayBuffer).byteLength} bytes>`;
  return `<${Object.prototype.toString.call(body)} body>`;
}

/** Deep copy for evidence: base64 payloads summarized, long strings truncated, secrets scrubbed. */
export function sanitize(value: unknown, scrub: (s: string) => string, key?: string): unknown {
  if (typeof value === "string") {
    if ((key === "data" || key === "signature") && value.length > 120) return `<${key}: ${value.length} chars omitted>`;
    return truncate(scrub(value));
  }
  if (Array.isArray(value)) return value.map((v) => sanitize(v, scrub));
  if (isObj(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = sanitize(v, scrub, k);
    return out;
  }
  return value;
}

function truncate(s: string): string {
  return s.length > MAX_STRING ? `${s.slice(0, MAX_STRING)}… [${s.length - MAX_STRING} more chars]` : s;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}
