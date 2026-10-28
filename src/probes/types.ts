import type Anthropic from "@anthropic-ai/sdk";
import type { AuthSpec, ResolvedProfile } from "../profile";
import type { Exchange, Usage } from "../recorder";
import type { Feature, SupportView } from "./support";

export type Category =
  | "connectivity"
  | "messages"
  | "streaming"
  | "multimodal"
  | "tools"
  | "structured"
  | "reasoning"
  | "caching"
  | "tokens"
  | "server-tools"
  | "batches"
  | "files"
  | "sdk"
  | "beta";

export const CATEGORIES: { id: Category; label: string; blurb: string }[] = [
  { id: "connectivity", label: "Connectivity & auth", blurb: "Can the SDK reach the model at all, with which credential header, and is the API version honored." },
  { id: "messages", label: "Messages", blurb: "Core request shapes: system prompts, multi-turn, stop sequences, limits, metadata." },
  { id: "streaming", label: "Streaming", blurb: "Server-sent events end to end, including whether the gateway buffers them." },
  { id: "multimodal", label: "Images & documents", blurb: "Image, PDF, and plain-text inputs, and citations." },
  { id: "tools", label: "Tool use", blurb: "Client tools from a single call through parallel calls, tool_choice, strict schemas, and the SDK tool runner." },
  { id: "structured", label: "Structured outputs", blurb: "JSON-schema-constrained responses, including the SDK's parse helper." },
  { id: "reasoning", label: "Thinking & effort", blurb: "Adaptive thinking, effort levels, and thinking blocks surviving a tool round trip." },
  { id: "caching", label: "Prompt caching", blurb: "Cache writes and reads, explicit and automatic." },
  { id: "tokens", label: "Token counting", blurb: "The count_tokens endpoint and how closely it matches billed usage." },
  { id: "server-tools", label: "Server tools", blurb: "Tools Anthropic runs: web search, web fetch, code execution, tool search." },
  { id: "batches", label: "Message Batches", blurb: "The asynchronous batch endpoint." },
  { id: "files", label: "Files API", blurb: "Upload, reference, and delete files." },
  { id: "sdk", label: "SDK behavior", blurb: "Typed errors, timeouts, request IDs, and response headers." },
  { id: "beta", label: "Beta features (anthropic-beta)", blurb: "Features enabled by the anthropic-beta header, which gateways often strip." },
];

export type Cost = "free" | "low" | "medium" | "high";

/**
 * Outcome of one test case.
 * - pass:        worked as expected
 * - warn:        worked, with a caveat worth reading
 * - fail:        should have worked and didn't
 * - blocked:     the gateway refused (auth, route not found, method not allowed)
 * - unsupported: the model rejected the feature (expected for this model where noted)
 * - n/a:         the upstream platform does not offer this; nothing was sent
 * - skipped:     not run (missing configuration, or a prerequisite failed)
 * - error:       transient (network, timeout, rate limit, 5xx); re-run before concluding anything
 */
export type Status = "pass" | "warn" | "fail" | "blocked" | "unsupported" | "n/a" | "skipped" | "error";

/** The documented test case. Rendered verbatim into the evidence report and the catalog. */
export interface ProbeSpec {
  /** Stable test case ID, e.g. TC-TOOL-03. */
  id: string;
  title: string;
  category: Category;
  /** What this test case verifies, and why it matters through a gateway. */
  purpose: string;
  /** API endpoint and SDK method exercised. */
  surface: string;
  steps: string[];
  expected: string;
  betas?: string[];
  cost: Cost;
  /** Excluded from the default selection: slow or comparatively expensive. */
  optIn?: boolean;
  /** Ties the case to the model and platform support matrix. */
  feature?: Feature;
  /** Profile settings the case needs; it is skipped without them. */
  requires?: ("mcpServerUrl")[];
}

export interface Check {
  label: string;
  ok: boolean;
  level: "required" | "advisory";
  detail?: string;
}

export interface ProbeContext {
  profile: ResolvedProfile;
  model: string;
  client: Anthropic;
  support: SupportView;
  /** A client with different auth or settings, recording into the same evidence. */
  makeClient(opts?: { auth?: AuthSpec; timeoutMs?: number; maxRetries?: number }): Anthropic;
  /** Labels the HTTP exchanges that follow, so the evidence says what each one was for. */
  label(text?: string): void;
  /** A required check: a false result fails the case. */
  check(label: string, ok: boolean, detail?: string): boolean;
  /** An advisory check: a false result downgrades the case to a warning. */
  advise(label: string, ok: boolean, detail?: string): boolean;
  note(text: string): void;
  /** Structured observations used to derive the run's findings. */
  fact(key: string, value: unknown): void;
  /** Exchanges recorded so far in this case. */
  exchanges(): Exchange[];
  /** The anthropic-version actually sent, read from the recorded request. */
  sentApiVersion(): string | undefined;
  /** Unique per run, so cached prefixes never collide with a previous run. */
  nonce: string;
  signal: AbortSignal;
}

export interface ProbeDef extends ProbeSpec {
  run(ctx: ProbeContext): Promise<void>;
}

export interface ClassifiedError {
  kind: "auth" | "forbidden" | "not_found" | "method" | "bad_request" | "rate_limit" | "server" | "network" | "timeout" | "aborted" | "sdk" | "unknown";
  status?: number;
  type?: string;
  message: string;
  className?: string;
  requestId?: string;
}

export interface ProbeResult {
  id: string;
  status: Status;
  summary: string;
  hint?: string;
  checks: Check[];
  notes: string[];
  facts: Record<string, unknown>;
  error?: ClassifiedError;
  expectation: string;
  exchanges: Exchange[];
  usage: Usage;
  costUsd: number | null;
  startedAt: string;
  durationMs: number;
}

/** Thrown by a case that cannot run in this configuration. */
export class SkipProbe extends Error {
  constructor(
    public reason: string,
    public status: "skipped" | "n/a" = "skipped",
  ) {
    super(reason);
  }
}

export function defineProbe(def: ProbeDef): ProbeDef {
  return def;
}

export const STATUS_ORDER: Status[] = ["pass", "warn", "fail", "blocked", "unsupported", "error", "n/a", "skipped"];
