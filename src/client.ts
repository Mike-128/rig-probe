import Anthropic from "@anthropic-ai/sdk";
import { AnthropicVertex } from "@anthropic-ai/vertex-sdk";
import type { AuthSpec, ResolvedProfile } from "./profile";

export interface BuildClientOptions {
  profile: ResolvedProfile;
  secret: string;
  fetch?: typeof fetch;
  /** Use a different auth mode than the profile's, e.g. for auth discovery. */
  auth?: AuthSpec;
  timeoutMs?: number;
  maxRetries?: number;
}

/**
 * Builds the SDK client a real application would use against this target.
 *
 * Auth is the subtle part. @anthropic-ai/sdk v1 sends an API key as `Authorization: Bearer`, where
 * v0 sent `X-Api-Key`. For a gateway that reads another header the documented pattern is to pass
 * the key and set `Authorization: null` so the bearer copy is suppressed. Passing the key as
 * `apiKey` (rather than nothing) also stops the client from picking up ANTHROPIC_API_KEY or a
 * local profile from the environment, which would otherwise leak into requests to the gateway.
 *
 * Returned as `Anthropic` so probes share one surface; the Vertex client has the same messages
 * API, and probes for endpoints Vertex lacks are never sent on a Vertex target.
 */
export function buildClient(o: BuildClientOptions): Anthropic {
  const p = o.profile;
  const auth = o.auth ?? p.auth;
  const secret = o.secret;
  const headers: Record<string, string | null> = { ...p.extraHeaders };
  if (p.apiVersion) headers["anthropic-version"] = p.apiVersion;
  const common = {
    baseURL: p.baseUrl,
    fetch: o.fetch,
    defaultQuery: Object.keys(p.query).length ? p.query : undefined,
    timeout: o.timeoutMs ?? p.timeoutSec * 1000,
    maxRetries: o.maxRetries ?? 2,
  };

  if (p.client === "anthropic") {
    switch (auth.mode) {
      case "bearer":
        return new Anthropic({ ...common, apiKey: secret, defaultHeaders: headers });
      case "x-api-key":
        return new Anthropic({ ...common, apiKey: secret, defaultHeaders: { ...headers, "X-Api-Key": secret, Authorization: null } });
      case "header": {
        // Suppress the SDK's own bearer header, unless the gateway's header is Authorization itself.
        const own = auth.headerName!.toLowerCase() === "authorization" ? {} : { Authorization: null };
        return new Anthropic({
          ...common,
          apiKey: secret || "unused",
          defaultHeaders: { ...headers, ...own, [auth.headerName!]: `${auth.prefix ?? ""}${secret}` },
        });
      }
      case "none":
        return new Anthropic({ ...common, apiKey: "unused", defaultHeaders: { ...headers, Authorization: null } });
      case "google-adc":
        throw new Error("Google Application Default Credentials need the Vertex client.");
    }
  }

  // Vertex client. It always asks a Google auth client for headers and applies them after the
  // default headers, so `Authorization: null` cannot suppress them. Through a gateway that holds
  // the Google credential, hand it a stub auth client that returns the gateway credential instead.
  const vertex = p.vertex!;
  const vertexOptions = { ...common, region: vertex.region, projectId: vertex.projectId, defaultHeaders: headers };
  if (auth.mode === "google-adc") return new AnthropicVertex(vertexOptions) as unknown as Anthropic;
  const authHeaders: Record<string, string> =
    auth.mode === "bearer"
      ? { Authorization: `Bearer ${secret}` }
      : auth.mode === "x-api-key"
        ? { "X-Api-Key": secret }
        : auth.mode === "header"
          ? { [auth.headerName!]: `${auth.prefix ?? ""}${secret}` }
          : {};
  const authClient = {
    projectId: vertex.projectId,
    getRequestHeaders: async () => new Headers(authHeaders),
  };
  type VertexAuthClient = NonNullable<ConstructorParameters<typeof AnthropicVertex>[0]>["authClient"];
  return new AnthropicVertex({ ...vertexOptions, authClient: authClient as unknown as VertexAuthClient }) as unknown as Anthropic;
}

/** Header names that carry the credential for this auth spec, for redaction. */
export function credentialHeaders(auth: AuthSpec): string[] {
  return auth.mode === "header" && auth.headerName ? [auth.headerName] : [];
}

export function describeAuth(auth: AuthSpec): string {
  switch (auth.mode) {
    case "bearer":
      return "Authorization: Bearer <key>";
    case "x-api-key":
      return "X-Api-Key: <key>";
    case "header":
      return `${auth.headerName}: ${auth.prefix ?? ""}<key>`;
    case "google-adc":
      return "Google Application Default Credentials";
    case "none":
      return "no credential (gateway injects one)";
  }
}
