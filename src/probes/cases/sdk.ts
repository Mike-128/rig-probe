import Anthropic from "@anthropic-ai/sdk";
import { defineProbe } from "../types";
import { base, excerpt } from "./_util";

export const sdk = [
  defineProbe({
    id: "TC-SDK-01",
    title: "Typed error for an unknown model, without retry",
    category: "sdk",
    purpose:
      "Checks the gateway returns errors the SDK can classify. Applications branch on the SDK's typed exceptions (NotFoundError, RateLimitError, …), and the SDK retries only 408/409/429/5xx; a gateway that turns client errors into 5xx makes the SDK retry requests that can never succeed.",
    surface: "POST /v1/messages · Anthropic.NotFoundError, retry policy",
    steps: ["Request a model that does not exist, with the SDK's default retries enabled.", "Inspect the error type and count the HTTP attempts."],
    expected: "An APIError subclass, ideally NotFoundError (404), after exactly one attempt.",
    cost: "free",
    async run(ctx) {
      let error: unknown;
      try {
        await ctx.makeClient({ maxRetries: 2 }).messages.create({ model: "rig-probe-no-such-model", max_tokens: 16, messages: [{ role: "user", content: "Hi" }] });
      } catch (err) {
        error = err;
      }
      const attempts = ctx.exchanges().length;
      ctx.check("Request failed with a typed API error", error instanceof Anthropic.APIError, error instanceof Error ? `${error.constructor.name}: ${excerpt(error.message)}` : "no error");
      const status = error instanceof Anthropic.APIError ? error.status : undefined;
      ctx.check("Status is a client error (4xx), not a server error", status !== undefined && status >= 400 && status < 500, `HTTP ${status}`);
      ctx.advise("Error is NotFoundError (404)", error instanceof Anthropic.NotFoundError, `HTTP ${status}`);
      ctx.advise("Not retried (one attempt)", attempts === 1, `${attempts} attempt(s)`);
    },
  }),

  defineProbe({
    id: "TC-SDK-02",
    title: "Typed error for an invalid request",
    category: "sdk",
    purpose: "Checks a malformed request comes back as a 400 that the SDK maps to BadRequestError, with the API's explanation intact rather than replaced by a gateway error page.",
    surface: "POST /v1/messages · Anthropic.BadRequestError",
    steps: ["Send a request with an empty messages array."],
    expected: "BadRequestError (400) with an invalid_request_error explanation.",
    cost: "free",
    async run(ctx) {
      let error: unknown;
      try {
        await ctx.client.messages.create({ model: ctx.model, max_tokens: 16, messages: [] }, { maxRetries: 0 });
      } catch (err) {
        error = err;
      }
      ctx.check("Raised BadRequestError", error instanceof Anthropic.BadRequestError, error instanceof Error ? error.constructor.name : "no error");
      const body = error instanceof Anthropic.APIError ? (error.error as { error?: { type?: string } } | undefined) : undefined;
      ctx.advise("Body is the API's invalid_request_error", body?.error?.type === "invalid_request_error", excerpt(JSON.stringify(body ?? {})));
    },
  }),

  defineProbe({
    id: "TC-SDK-03",
    title: "Request ID and rate-limit headers",
    category: "sdk",
    purpose:
      "Checks response headers survive the gateway. The request-id header is what Anthropic support needs to trace a request; anthropic-ratelimit-* headers let applications pace themselves. Gateways often strip unknown response headers.",
    surface: "client.messages.create().withResponse() · response headers",
    steps: ["Send a request using withResponse() to get the raw HTTP response.", "Record the response header names."],
    expected: "A request ID, and on the Anthropic API, anthropic-ratelimit-* headers.",
    cost: "low",
    async run(ctx) {
      const { data, response, request_id } = await ctx.client.messages.create({ ...base(ctx), messages: [{ role: "user", content: "Reply with OK." }] }).withResponse();
      ctx.check("Response received", data.type === "message");
      const names = [...response.headers.keys()].sort();
      ctx.advise("Request ID returned", Boolean(request_id), request_id ?? "missing");
      if (ctx.support.platform === "anthropic") {
        const rl = names.filter((n) => n.startsWith("anthropic-ratelimit-"));
        ctx.advise("Rate-limit headers returned", rl.length > 0, rl.length ? rl.join(", ") : "none");
      }
      ctx.fact("responseHeaderNames", names);
      ctx.fact("requestIdReturned", Boolean(request_id));
    },
  }),

  defineProbe({
    id: "TC-SDK-04",
    title: "Client timeout",
    category: "sdk",
    purpose: "Checks the per-request timeout option raises the SDK's timeout error rather than hanging.",
    surface: "client.messages.create(params, { timeout }) · Anthropic.APIConnectionTimeoutError",
    steps: ["Send a request with a 1 ms timeout and retries off."],
    expected: "APIConnectionTimeoutError.",
    cost: "free",
    async run(ctx) {
      let error: unknown;
      try {
        await ctx.client.messages.create({ ...base(ctx, { maxTokens: 16 }), messages: [{ role: "user", content: "Hi" }] }, { timeout: 1, maxRetries: 0 });
      } catch (err) {
        error = err;
      }
      ctx.check("Raised APIConnectionTimeoutError", error instanceof Anthropic.APIConnectionTimeoutError, error instanceof Error ? error.constructor.name : "completed within 1 ms");
    },
  }),
];
