import Anthropic from "@anthropic-ai/sdk";
import type { Exchange } from "../recorder";
import type { ClassifiedError, ProbeSpec, Status } from "./types";
import type { Verdict } from "./support";

/** Words in a 400 that mean "this model or platform doesn't do that", as opposed to a malformed request. */
const CAPABILITY_REJECTION = /not supported|does not support|unsupported|not available|is not enabled|not allowed for this model|only supported|not compatible|is not supported on this model/i;
/** Words in a 400 that mean "the server didn't recognize a field", typical when a beta header never arrived. */
const UNKNOWN_FIELD = /extra inputs are not permitted|unknown field|unrecognized|unexpected (field|parameter|property)|not permitted|is not a valid|no such field/i;

export function classifyError(err: unknown): ClassifiedError {
  if (err instanceof Anthropic.APIUserAbortError) return { kind: "aborted", message: err.message, className: "APIUserAbortError" };
  if (err instanceof Anthropic.APIConnectionTimeoutError) return { kind: "timeout", message: err.message, className: "APIConnectionTimeoutError" };
  if (err instanceof Anthropic.APIConnectionError) {
    const cause = err.cause instanceof Error ? ` (${err.cause.message})` : "";
    return { kind: "network", message: `${err.message}${cause}`, className: "APIConnectionError" };
  }
  if (err instanceof Anthropic.APIError) {
    const status = err.status;
    const body = (err.error ?? {}) as { error?: { type?: string; message?: string }; type?: string; message?: string };
    const type = body.error?.type ?? body.type;
    const message = body.error?.message ?? body.message ?? err.message;
    const base = { status, type, message: String(message), className: err.constructor.name, requestId: err.requestID ?? undefined };
    if (status === 401) return { ...base, kind: "auth" };
    if (status === 403) return { ...base, kind: "forbidden" };
    if (status === 404) return { ...base, kind: "not_found" };
    if (status === 405) return { ...base, kind: "method" };
    if (status === 429) return { ...base, kind: "rate_limit" };
    if (status !== undefined && status >= 500) return { ...base, kind: "server" };
    if (status !== undefined && status >= 400) return { ...base, kind: "bad_request" };
    return { ...base, kind: "unknown" };
  }
  if (err instanceof Anthropic.AnthropicError) return { kind: "sdk", message: err.message, className: err.constructor.name };
  return { kind: "unknown", message: err instanceof Error ? err.message : String(err), className: err instanceof Error ? err.constructor.name : undefined };
}

export interface Classification {
  status: Status;
  summary: string;
  hint?: string;
  betaHeaderSuspect?: boolean;
}

/**
 * Turns an error into an outcome for a specific case. The distinctions that matter through a
 * gateway: the gateway refused it (blocked), the model refused it as documented (unsupported), it
 * should have worked (fail), or it was transient (error).
 */
export function outcomeForError(e: ClassifiedError, spec: ProbeSpec, expectation: Verdict, lastExchange?: Exchange): Classification {
  const path = lastExchange ? safePath(lastExchange.url) : undefined;
  const where = path ? ` on ${lastExchange!.method} ${path}` : "";
  const msg = e.message;

  switch (e.kind) {
    case "auth":
      return {
        status: "blocked",
        summary: `Authentication rejected (401)${where}.`,
        hint: "Check the key and which header carries it. @anthropic-ai/sdk v1 sends API keys as Authorization: Bearer; a gateway that reads X-Api-Key or a custom header needs the key there and Authorization suppressed. Run TC-CONN-02 to see which header this gateway accepts.",
      };
    case "forbidden":
      return {
        status: "blocked",
        summary: `Forbidden (403)${where}: ${msg}`,
        hint: "Either a gateway policy refused this route or method, or the key is not entitled to this model or feature. The response body above usually says which.",
      };
    case "method":
      return { status: "blocked", summary: `Method not allowed (405)${where}.`, hint: "The gateway does not expose this operation." };
    case "not_found": {
      const messagesRoute = path ? /\/v1\/messages(\?|$)|:rawPredict|:streamRawPredict/.test(path) : false;
      if (messagesRoute && /model/i.test(msg)) {
        return { status: "fail", summary: `Model not found (404): ${msg}`, hint: "Check the model ID. Through a gateway it may be a deployment name rather than Anthropic's model ID." };
      }
      return {
        status: "blocked",
        summary: `Not found (404)${where}.`,
        hint: messagesRoute ? "The gateway did not route this request to the model." : `The gateway does not route ${path ?? "this endpoint"}. Add it to the gateway's API definition if the application needs it.`,
      };
    }
    case "bad_request": {
      if (expectation === "unsupported") {
        return { status: "unsupported", summary: `Rejected by the model, as documented: ${msg}` };
      }
      if (spec.betas?.length && UNKNOWN_FIELD.test(msg)) {
        return {
          status: "fail",
          summary: `Request rejected (${e.status}): ${msg}`,
          hint: `The API did not recognize a beta-only field, which usually means the anthropic-beta header (${spec.betas.join(", ")}) never reached it. Check that the gateway forwards anthropic-beta.`,
          betaHeaderSuspect: true,
        };
      }
      if (CAPABILITY_REJECTION.test(msg)) {
        return {
          status: "unsupported",
          summary: `Rejected as unsupported (${e.status}): ${msg}`,
          hint: expectation === "supported" ? "This was expected to work on this model, so the rejection may come from the gateway or platform rather than the model." : undefined,
        };
      }
      return { status: "fail", summary: `Request rejected (${e.status}): ${msg}` };
    }
    case "rate_limit":
      return { status: "error", summary: `Rate limited (429)${where}: ${msg}`, hint: "Transient. Re-run this case after the limit resets before drawing conclusions." };
    case "server":
      return {
        status: "error",
        summary: `Server error (${e.status})${where}: ${msg}`,
        hint: e.status === 502 || e.status === 504 ? "502 and 504 usually come from the gateway itself: an upstream timeout or connection failure." : "Usually transient. Re-run before drawing conclusions.",
      };
    case "timeout":
      return { status: "error", summary: `Timed out${where}.`, hint: "Raise the timeout in the target settings, or check whether the gateway holds streaming responses open." };
    case "network":
      return { status: "error", summary: `Could not connect${where}: ${msg}`, hint: "Check the base URL, DNS, proxy, and TLS settings." };
    case "aborted":
      return { status: "error", summary: "The request was aborted." };
    case "sdk":
      return { status: "fail", summary: `SDK error: ${msg}` };
    default:
      return { status: "fail", summary: `Unexpected error: ${msg}` };
  }
}

function safePath(url: string): string {
  try {
    const u = new URL(url);
    return u.pathname + u.search;
  } catch {
    return url;
  }
}
