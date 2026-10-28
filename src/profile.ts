import { z } from "zod";

/**
 * A target is "where the SDK sends requests, and what serves them". The two are separate on
 * purpose: Vertex AI behind APIM can be reached with either SDK client depending on what APIM
 * exposes, but what is *available* always follows the upstream platform.
 */

/** What actually serves the model. Decides which features exist at all. */
export const PlatformSchema = z.enum(["anthropic", "vertex"]);
export type Platform = z.infer<typeof PlatformSchema>;

/** Which SDK client sends the requests. Decides the wire shape. */
export const ClientKindSchema = z.enum(["anthropic", "vertex"]);
export type ClientKind = z.infer<typeof ClientKindSchema>;

/**
 * How the credential is sent.
 * - bearer:     Authorization: Bearer <key>  (what @anthropic-ai/sdk v1 sends for an API key)
 * - x-api-key:  X-Api-Key: <key>            (what v0 sent; many gateways still read it)
 * - header:     a named header, e.g. Ocp-Apim-Subscription-Key for Azure API Management
 * - google-adc: Google Application Default Credentials (Vertex client, direct to Google only)
 * - none:       send no credential (the gateway injects one)
 */
export const AuthModeSchema = z.enum(["bearer", "x-api-key", "header", "google-adc", "none"]);
export type AuthMode = z.infer<typeof AuthModeSchema>;

export const AuthSpecSchema = z.object({
  mode: AuthModeSchema,
  headerName: z.string().optional(),
  prefix: z.string().optional(),
});
export type AuthSpec = z.infer<typeof AuthSpecSchema>;

export const ProfileSchema = z
  .object({
    name: z.string().min(1),
    platform: PlatformSchema,
    client: ClientKindSchema,
    baseUrl: z.string().url(),
    model: z.string().min(1),
    auth: AuthSpecSchema,
    vertex: z.object({ projectId: z.string(), region: z.string() }).optional(),
    extraHeaders: z.record(z.string(), z.string()).optional(),
    query: z.record(z.string(), z.string()).optional(),
    /** Override the anthropic-version the SDK sends. Blank means the SDK default. */
    apiVersion: z.string().optional(),
    imageUrl: z.string().url().optional(),
    mcpServerUrl: z.string().url().optional(),
    mcpServerName: z.string().optional(),
    timeoutSec: z.number().int().positive().optional(),
    batchTimeoutSec: z.number().int().positive().optional(),
  })
  .superRefine((p, ctx) => {
    if (p.client === "vertex" && p.platform !== "vertex") {
      ctx.addIssue({ code: "custom", path: ["client"], message: "The Vertex client only makes sense when the upstream platform is Vertex AI." });
    }
    if (p.client === "vertex" && (!p.vertex?.region || !p.vertex?.projectId)) {
      ctx.addIssue({ code: "custom", path: ["vertex"], message: "The Vertex client needs a GCP project ID and region; both are part of the request path." });
    }
    if (p.auth.mode === "header" && !p.auth.headerName?.trim()) {
      ctx.addIssue({ code: "custom", path: ["auth", "headerName"], message: "Header mode needs a header name, e.g. Ocp-Apim-Subscription-Key." });
    }
    if (p.auth.mode === "google-adc" && p.client !== "vertex") {
      ctx.addIssue({ code: "custom", path: ["auth", "mode"], message: "Google Application Default Credentials only apply to the Vertex client." });
    }
  });
export type Profile = z.infer<typeof ProfileSchema>;

export const DEFAULT_IMAGE_URL = "https://upload.wikimedia.org/wikipedia/commons/4/47/PNG_transparency_demonstration_1.png";

/** Profile with every optional setting resolved. */
export interface ResolvedProfile extends Profile {
  extraHeaders: Record<string, string>;
  query: Record<string, string>;
  imageUrl: string;
  timeoutSec: number;
  batchTimeoutSec: number;
}

export function resolveProfile(p: Profile): ResolvedProfile {
  return {
    ...p,
    baseUrl: p.baseUrl.replace(/\/+$/, ""),
    extraHeaders: p.extraHeaders ?? {},
    query: p.query ?? {},
    apiVersion: p.apiVersion?.trim() || undefined,
    imageUrl: p.imageUrl ?? DEFAULT_IMAGE_URL,
    timeoutSec: p.timeoutSec ?? 180,
    batchTimeoutSec: p.batchTimeoutSec ?? 900,
  };
}

export interface Preset {
  id: string;
  label: string;
  description: string;
  profile: Profile;
}

const APIM_HEADER = "Ocp-Apim-Subscription-Key";

export const PRESETS: Preset[] = [
  {
    id: "anthropic-apim",
    label: "Anthropic 1P via APIM",
    description:
      "APIM fronts api.anthropic.com. The SDK's standard client points at APIM and sends the APIM subscription key. Replace the base URL with the APIM URL that maps to https://api.anthropic.com (without /v1).",
    profile: {
      name: "Anthropic 1P via APIM",
      platform: "anthropic",
      client: "anthropic",
      baseUrl: "https://YOUR-APIM.azure-api.net/anthropic",
      model: "claude-opus-5-5",
      auth: { mode: "header", headerName: APIM_HEADER },
    },
  },
  {
    id: "vertex-apim",
    label: "Google Vertex AI via APIM (Vertex routes)",
    description:
      "APIM passes Vertex AI's own routes through (…/projects/P/locations/R/publishers/anthropic/models/M:rawPredict). Uses the SDK's Vertex client. Base URL is the APIM URL that maps to https://REGION-aiplatform.googleapis.com/v1. APIM holds the Google credential; the probe sends the APIM key.",
    profile: {
      name: "Vertex AI via APIM",
      platform: "vertex",
      client: "vertex",
      baseUrl: "https://YOUR-APIM.azure-api.net/vertex/v1",
      model: "claude-opus-5-5",
      auth: { mode: "header", headerName: APIM_HEADER },
      vertex: { projectId: "your-gcp-project", region: "global" },
    },
  },
  {
    id: "vertex-apim-messages",
    label: "Google Vertex AI via APIM (APIM exposes /v1/messages)",
    description:
      "APIM accepts Anthropic-shaped /v1/messages requests and translates them to Vertex itself. Uses the SDK's standard client, but availability follows Vertex AI: no Files, Batches, or Models API, no web fetch or code execution.",
    profile: {
      name: "Vertex AI via APIM (messages shape)",
      platform: "vertex",
      client: "anthropic",
      baseUrl: "https://YOUR-APIM.azure-api.net/anthropic",
      model: "claude-opus-5-5",
      auth: { mode: "header", headerName: APIM_HEADER },
    },
  },
  {
    id: "anthropic-direct",
    label: "Anthropic 1P direct (baseline, no gateway)",
    description:
      "Straight to api.anthropic.com with an Anthropic API key. Run this alongside a gateway profile: any difference between the two reports is the gateway's doing.",
    profile: {
      name: "Anthropic 1P direct",
      platform: "anthropic",
      client: "anthropic",
      baseUrl: "https://api.anthropic.com",
      model: "claude-opus-5-5",
      auth: { mode: "bearer" },
    },
  },
  {
    id: "vertex-direct",
    label: "Google Vertex AI direct (baseline, gcloud credentials)",
    description:
      "Straight to Vertex AI using Application Default Credentials (run `gcloud auth application-default login` first). Leave the key blank. Baseline for the Vertex-via-APIM profile.",
    profile: {
      name: "Vertex AI direct",
      platform: "vertex",
      client: "vertex",
      baseUrl: "https://aiplatform.googleapis.com/v1",
      model: "claude-opus-5-5",
      auth: { mode: "google-adc" },
      vertex: { projectId: "your-gcp-project", region: "global" },
    },
  },
];

/** Profile as written into evidence: secrets and secret-looking values removed. */
export function publicProfile(p: ResolvedProfile): Record<string, unknown> {
  const SECRETISH = /key|token|secret|auth|sig|password|cookie|credential|subscription/i;
  const mask = (rec: Record<string, string>) =>
    Object.fromEntries(Object.entries(rec).map(([k, v]) => [k, SECRETISH.test(k) ? "[REDACTED]" : v]));
  return {
    name: p.name,
    platform: p.platform,
    client: p.client,
    baseUrl: p.baseUrl,
    model: p.model,
    auth: { mode: p.auth.mode, headerName: p.auth.headerName, prefix: p.auth.prefix ? "[set]" : undefined },
    vertex: p.vertex,
    extraHeaders: mask(p.extraHeaders),
    query: mask(p.query),
    apiVersion: p.apiVersion ?? "(SDK default)",
    imageUrl: p.imageUrl,
    mcpServerUrl: p.mcpServerUrl,
    timeoutSec: p.timeoutSec,
    batchTimeoutSec: p.batchTimeoutSec,
  };
}
