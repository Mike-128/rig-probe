import { type Profile, ProfileSchema, resolveProfile, type ResolvedProfile } from "../src/profile";
import type { Mock } from "./mock-anthropic";

export const KEY = "sk-test-SECRET-7f3a9c";
export const APIM_HEADER = "Ocp-Apim-Subscription-Key";

/** Anthropic 1P behind APIM: the standard client, key in the APIM subscription header. */
export function anthropicApim(mock: Mock, overrides: Partial<Profile> = {}): Profile {
  return ProfileSchema.parse({
    name: "Anthropic 1P via APIM (mock)",
    platform: "anthropic",
    client: "anthropic",
    baseUrl: `${mock.url}/anthropic`,
    model: "claude-opus-5-5",
    auth: { mode: "header", headerName: APIM_HEADER },
    ...overrides,
  });
}

/** Anthropic on Vertex AI behind APIM: the Vertex client, key in the APIM subscription header. */
export function vertexApim(mock: Mock, overrides: Partial<Profile> = {}): Profile {
  return ProfileSchema.parse({
    name: "Vertex via APIM (mock)",
    platform: "vertex",
    client: "vertex",
    baseUrl: `${mock.url}/vertex/v1`,
    model: "claude-opus-5-5",
    auth: { mode: "header", headerName: APIM_HEADER },
    vertex: { projectId: "probe-project", region: "global" },
    ...overrides,
  });
}

export const resolved = (p: Profile): ResolvedProfile => resolveProfile(p);
