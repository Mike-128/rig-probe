import Anthropic from "@anthropic-ai/sdk";
import { describeAuth } from "../../client";
import type { AuthSpec } from "../../profile";
import { defineProbe, SkipProbe } from "../types";
import { base, excerpt, textOf } from "./_util";

export const connectivity = [
  defineProbe({
    id: "TC-CONN-01",
    title: "Basic message request",
    category: "connectivity",
    purpose:
      "Establishes that the SDK can reach the model through this target at all. Every other case depends on it: if it does not pass, the remaining cases are skipped rather than spending requests on a broken path.",
    surface: "POST /v1/messages · client.messages.create()",
    steps: ["Send a single user message asking for the exact reply PROBE-OK.", "Inspect the response object, usage, and request ID."],
    expected: "HTTP 200 with a message whose text contains PROBE-OK, a model name, token usage, and a request ID.",
    cost: "low",
    async run(ctx) {
      const res = await ctx.client.messages.create({ ...base(ctx), messages: [{ role: "user", content: "Reply with exactly: PROBE-OK" }] });
      ctx.check("Response is a message object", res.type === "message", res.type);
      ctx.check("Reply contains PROBE-OK", textOf(res).includes("PROBE-OK"), excerpt(textOf(res)));
      ctx.check("Token usage is reported", (res.usage?.input_tokens ?? 0) > 0, `${res.usage?.input_tokens} in / ${res.usage?.output_tokens} out`);
      ctx.advise("Response names the serving model", Boolean(res.model), res.model);
      ctx.advise("stop_reason is end_turn", res.stop_reason === "end_turn", String(res.stop_reason));
      ctx.advise("Request ID is returned (needed for support tickets)", Boolean(res._request_id), res._request_id ?? "missing");
      ctx.fact("servedModel", res.model);
      ctx.fact("apiVersionSent", ctx.sentApiVersion());
    },
  }),

  defineProbe({
    id: "TC-CONN-02",
    title: "Credential header discovery",
    category: "connectivity",
    purpose:
      "Finds which header the gateway accepts the credential in. This matters for the SDK v1 upgrade: @anthropic-ai/sdk v1 sends API keys as Authorization: Bearer where v0 sent X-Api-Key, so a gateway that reads X-Api-Key or its own header breaks silently on upgrade unless clients are configured for it.",
    surface: "POST /v1/messages · client.messages.create() with each credential placement",
    steps: [
      "Send a minimal request with the configured credential placement.",
      "Repeat with Authorization: Bearer (the SDK v1 default) and with X-Api-Key, unless already covered.",
      "Treat 401/403 as rejected; any other HTTP status means the credential got past the gateway.",
    ],
    expected: "The configured placement is accepted. The other results are informational and describe the gateway.",
    cost: "low",
    async run(ctx) {
      const configured = ctx.profile.auth;
      if (configured.mode === "google-adc" || configured.mode === "none") {
        throw new SkipProbe(`Not applicable to the "${describeAuth(configured)}" auth mode: no key is sent.`);
      }
      const candidates: AuthSpec[] = [configured];
      if (configured.mode !== "bearer") candidates.push({ mode: "bearer" });
      if (configured.mode !== "x-api-key") candidates.push({ mode: "x-api-key" });

      const results: { placement: string; accepted: boolean | null; status: number | string }[] = [];
      for (const auth of candidates) {
        const placement = describeAuth(auth);
        ctx.label(`credential as ${placement}`);
        try {
          await ctx.makeClient({ auth, maxRetries: 0 }).messages.create({ ...base(ctx, { maxTokens: 64 }), messages: [{ role: "user", content: "Reply with OK." }] });
          results.push({ placement, accepted: true, status: 200 });
        } catch (err) {
          if (err instanceof Anthropic.APIError && err.status !== undefined) {
            results.push({ placement, accepted: !(err.status === 401 || err.status === 403), status: err.status });
          } else {
            results.push({ placement, accepted: null, status: err instanceof Error ? err.constructor.name : "error" });
          }
        }
      }
      ctx.label();
      const [mine, ...others] = results;
      ctx.check(`Configured placement accepted (${mine.placement})`, mine.accepted === true, `HTTP ${mine.status}`);
      for (const r of others) {
        ctx.note(`${r.placement}: ${r.accepted === true ? "accepted" : r.accepted === false ? "rejected" : "inconclusive"} (HTTP ${r.status})`);
      }
      const bearer = results.find((r) => r.placement.startsWith("Authorization"));
      if (bearer && configured.mode !== "bearer") {
        ctx.note(
          bearer.accepted
            ? "The gateway also accepts the SDK v1 default (Authorization: Bearer)."
            : "The gateway rejects the SDK v1 default (Authorization: Bearer). Applications on @anthropic-ai/sdk v1 must send the key in the gateway's header and pass Authorization: null in defaultHeaders.",
        );
      }
      ctx.fact("authPlacements", results);
    },
  }),

  defineProbe({
    id: "TC-CONN-03",
    title: "Models API: retrieve the target model",
    category: "connectivity",
    purpose:
      "Checks the Models endpoint is routed, and loads the model's live capability report. Later cases use that report to know what the model should support, so results don't rely only on this tool's built-in table.",
    surface: "GET /v1/models/{model_id} · client.models.retrieve()",
    steps: ["Retrieve the configured model by ID.", "Record its context window, output limit, and capabilities."],
    expected: "HTTP 200 with the model's ID, display name, max_input_tokens, max_tokens, and capabilities.",
    cost: "free",
    feature: "models_api",
    async run(ctx) {
      const m = await ctx.client.models.retrieve(ctx.model);
      ctx.check("Model is returned", Boolean(m.id), m.id);
      ctx.advise("Returned ID matches the requested model", m.id === ctx.model || ctx.model.startsWith(m.id), `${m.id} vs ${ctx.model}`);
      ctx.advise("Context window reported (max_input_tokens)", typeof m.max_input_tokens === "number", String(m.max_input_tokens));
      ctx.advise("Output limit reported (max_tokens)", typeof m.max_tokens === "number", String(m.max_tokens));
      const caps = (m as unknown as { capabilities?: Record<string, unknown> }).capabilities;
      ctx.advise("Capability report present", Boolean(caps && Object.keys(caps).length));
      ctx.fact("modelInfo", { id: m.id, display_name: m.display_name, max_input_tokens: m.max_input_tokens, max_tokens: m.max_tokens });
      if (caps) ctx.fact("liveCapabilities", caps);
    },
  }),

  defineProbe({
    id: "TC-CONN-04",
    title: "Models API: list with auto-pagination",
    category: "connectivity",
    purpose: "Checks the list endpoint and the SDK's automatic pagination, which requests further pages as you iterate.",
    surface: "GET /v1/models · for await (const m of client.models.list())",
    steps: ["Iterate the model list with a small page size so pagination is exercised.", "Stop after 100 models."],
    expected: "At least one model is listed, and the configured model is among them.",
    cost: "free",
    feature: "models_api",
    async run(ctx) {
      const ids: string[] = [];
      for await (const m of ctx.client.models.list({ limit: 5 })) {
        ids.push(m.id);
        if (ids.length >= 100) break;
      }
      ctx.check("At least one model listed", ids.length > 0, `${ids.length} models`);
      const pages = ctx.exchanges().filter((e) => e.url.includes("/v1/models")).length;
      ctx.advise("Pagination fetched more than one page", pages > 1 || ids.length < 5, `${pages} page request(s)`);
      ctx.advise("Configured model is listed", ids.some((id) => id === ctx.model || ctx.model.startsWith(id)), excerpt(ids.join(", "), 300));
      ctx.fact("listedModels", ids);
    },
  }),

  defineProbe({
    id: "TC-CONN-05",
    title: "API version reaches the API unchanged",
    category: "connectivity",
    purpose:
      "Detects a gateway that rewrites or pins anthropic-version. On API version 2026-10-21 (sent by @anthropic-ai/sdk v1), temperature is removed and any request carrying it returns 400; on 2023-06-01 it is accepted. A request with temperature therefore reveals which version the API actually received.",
    surface: "POST /v1/messages · client.messages.create() with temperature set",
    steps: ["Read the anthropic-version the SDK sent.", "Send a request that includes temperature: 1.", "Compare the outcome with what that version should do."],
    expected: "On 2026-10-21: HTTP 400 naming the sampling parameter. On 2023-06-01: HTTP 200.",
    cost: "free",
    async run(ctx) {
      const params = { ...base(ctx, { maxTokens: 64 }), temperature: 1, messages: [{ role: "user", content: "Reply with OK." }] };
      let accepted = false;
      let status: number | undefined;
      let message = "";
      try {
        await ctx.client.messages.create(params as unknown as Anthropic.MessageCreateParamsNonStreaming, { maxRetries: 0 });
        accepted = true;
      } catch (err) {
        if (!(err instanceof Anthropic.APIError) || err.status !== 400) throw err;
        status = 400;
        message = err.message;
      }
      const version = ctx.sentApiVersion() ?? "unknown";
      ctx.fact("apiVersionSent", version);
      const rejectsSampling = version >= "2026-10-21";
      if (rejectsSampling) {
        ctx.check(`temperature rejected, as API version ${version} requires`, !accepted, accepted ? "HTTP 200: accepted" : `HTTP ${status}: ${excerpt(message)}`);
        ctx.advise("Rejection names the sampling parameter", /temperature|sampling/i.test(message), excerpt(message));
        if (accepted) {
          ctx.note("The request carried temperature and still succeeded. The gateway may be rewriting anthropic-version to an older value, or forwarding to a deployment that ignores it.");
        }
      } else {
        ctx.check(`temperature accepted, as API version ${version} allows`, accepted, accepted ? "HTTP 200" : `HTTP ${status}: ${excerpt(message)}`);
      }
      ctx.fact("apiVersionHonored", rejectsSampling ? !accepted : accepted);
    },
  }),
];
