import Anthropic from "@anthropic-ai/sdk";
import { buildClient, credentialHeaders, describeAuth } from "../client";
import { addUsage, emptyUsage, estimateCost } from "../pricing";
import { type Profile, publicProfile, type ResolvedProfile, resolveProfile } from "../profile";
import { createRecorder, type Exchange, type Usage } from "../recorder";
import { environment } from "../versions";
import { classifyError, outcomeForError } from "./classify";
import { ALL_PROBES, MODEL_INFO_ID, PREREQUISITE_ID, specOf } from "./registry";
import { createSupport, type SupportView } from "./support";
import { type Check, type ProbeContext, type ProbeDef, type ProbeResult, type ProbeSpec, SkipProbe, type Status, STATUS_ORDER } from "./types";
import { deriveFindings, type Finding } from "../evidence/findings";

export interface RunRecord {
  schema: "rig-probe/run@1";
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  environment: ReturnType<typeof environment> & { apiVersionSent?: string };
  target: Record<string, unknown> & { authPlacement: string };
  modelSupport: { family: string | null; liveCapabilitiesLoaded: boolean };
  specs: Record<string, ProbeSpec>;
  results: ProbeResult[];
  summary: { total: number; counts: Record<Status, number>; usage: Usage; costUsd: number | null; verdict: string };
  findings: Finding[];
}

export type RunEvent =
  | { type: "run_started"; id: string; startedAt: string; caseIds: string[] }
  | { type: "case_started"; id: string; index: number; total: number }
  | { type: "case_finished"; result: ProbeResult; index: number; total: number }
  | { type: "run_finished"; run: RunRecord };

export interface RunOptions {
  profile: Profile;
  secret: string;
  caseIds?: string[];
  id?: string;
  onEvent?: (e: RunEvent) => void;
  signal?: AbortSignal;
  /** Injected for tests. */
  baseFetch?: typeof fetch;
}

export function makeRunId(profileName: string, at = new Date()): string {
  const stamp = at.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const slug = profileName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "target";
  return `${stamp}-${slug}`;
}

export async function runProbes(opts: RunOptions): Promise<RunRecord> {
  const profile = resolveProfile(opts.profile);
  const startedAt = new Date();
  const id = opts.id ?? makeRunId(profile.name, startedAt);
  const support = createSupport(profile.model, profile.platform);
  const nonce = id;
  const signal = opts.signal ?? new AbortController().signal;

  // The prerequisite always runs, first, even if not selected.
  const wanted = new Set(opts.caseIds ?? ALL_PROBES.filter((p) => !p.optIn).map((p) => p.id));
  wanted.add(PREREQUISITE_ID);
  const selected = ALL_PROBES.filter((p) => wanted.has(p.id));

  opts.onEvent?.({ type: "run_started", id, startedAt: startedAt.toISOString(), caseIds: selected.map((p) => p.id) });

  const results: ProbeResult[] = [];
  let prerequisiteFailed = false;
  let apiVersionSent: string | undefined;

  for (const [index, probe] of selected.entries()) {
    if (signal.aborted) break;
    opts.onEvent?.({ type: "case_started", id: probe.id, index, total: selected.length });
    const result = prerequisiteFailed
      ? skeleton(probe, "skipped", `Skipped: the prerequisite ${PREREQUISITE_ID} (basic message request) did not pass, so this path is not usable yet.`, support)
      : await runOne(probe, profile, opts.secret, support, nonce, signal, opts.baseFetch);
    results.push(result);

    if (probe.id === PREREQUISITE_ID && result.status !== "pass" && result.status !== "warn") prerequisiteFailed = true;
    if (probe.id === MODEL_INFO_ID && result.facts.liveCapabilities) support.setLive(result.facts.liveCapabilities as Record<string, unknown>);
    apiVersionSent ??= result.facts.apiVersionSent as string | undefined;
    opts.onEvent?.({ type: "case_finished", result, index, total: selected.length });
  }

  const finishedAt = new Date();
  const counts = Object.fromEntries(STATUS_ORDER.map((s) => [s, 0])) as Record<Status, number>;
  let usage = emptyUsage();
  let cost = 0;
  let costKnown = true;
  for (const r of results) {
    counts[r.status]++;
    usage = addUsage(usage, r.usage);
    if (r.costUsd === null) costKnown = false;
    else cost += r.costUsd;
  }

  const run: RunRecord = {
    schema: "rig-probe/run@1",
    id,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    environment: { ...environment(), apiVersionSent },
    target: { ...publicProfile(profile), authPlacement: describeAuth(profile.auth) },
    modelSupport: { family: support.family, liveCapabilitiesLoaded: support.liveLoaded },
    specs: Object.fromEntries(selected.map((p) => [p.id, specOf(p)])),
    results,
    summary: { total: results.length, counts, usage, costUsd: costKnown ? cost : null, verdict: verdictLine(counts, results.length) },
    findings: [],
  };
  run.findings = deriveFindings(run, profile);
  opts.onEvent?.({ type: "run_finished", run });
  return run;
}

async function runOne(
  probe: ProbeDef,
  profile: ResolvedProfile,
  secret: string,
  support: SupportView,
  nonce: string,
  signal: AbortSignal,
  baseFetch?: typeof fetch,
): Promise<ProbeResult> {
  const startedAt = new Date();
  const t0 = performance.now();
  const expectation = support.expect(probe.feature);

  if (expectation.verdict === "n/a") return skeleton(probe, "n/a", expectation.reason, support);
  if (probe.requires?.includes("mcpServerUrl") && !profile.mcpServerUrl) {
    return skeleton(probe, "skipped", "Skipped: needs an MCP server URL (target settings, advanced).", support);
  }

  const recorder = createRecorder({
    secrets: [secret],
    sensitiveHeaders: [...credentialHeaders(profile.auth), ...Object.keys(profile.extraHeaders)],
    baseFetch,
  });
  const checks: Check[] = [];
  const notes: string[] = [];
  const facts: Record<string, unknown> = {};
  const make = (o: { auth?: Parameters<typeof buildClient>[0]["auth"]; timeoutMs?: number; maxRetries?: number } = {}) =>
    buildClient({ profile, secret, fetch: recorder.fetch, ...o });

  const ctx: ProbeContext = {
    profile,
    model: profile.model,
    client: make(),
    support,
    makeClient: make,
    label: (t) => recorder.setLabel(t),
    check: (label, ok, detail) => {
      checks.push({ label, ok, level: "required", detail });
      return ok;
    },
    advise: (label, ok, detail) => {
      checks.push({ label, ok, level: "advisory", detail });
      return ok;
    },
    note: (t) => notes.push(t),
    fact: (k, v) => {
      facts[k] = v;
    },
    exchanges: () => recorder.snapshot(),
    sentApiVersion: () => sentVersion(recorder.snapshot()),
    nonce,
    signal,
  };

  let status: Status;
  let summary: string;
  let hint: string | undefined;
  let error: ProbeResult["error"];

  try {
    await probe.run(ctx);
    const failedRequired = checks.find((c) => c.level === "required" && !c.ok);
    const failedAdvisory = checks.find((c) => c.level === "advisory" && !c.ok);
    if (failedRequired) {
      status = "fail";
      summary = `${failedRequired.label}: ${failedRequired.detail ?? "no"}`;
    } else if (failedAdvisory) {
      status = "warn";
      summary = `Worked, with a caveat: ${failedAdvisory.label.toLowerCase()} (${failedAdvisory.detail ?? "no"}).`;
    } else {
      status = "pass";
      summary = checks.length ? `All ${checks.length} checks passed.` : "Completed.";
    }
    if (expectation.verdict === "unsupported" && status !== "fail") {
      notes.push("This model is documented not to support this feature, but the request was accepted.");
    }
  } catch (err) {
    if (err instanceof SkipProbe) {
      status = err.status;
      summary = err.reason;
    } else {
      error = classifyError(err);
      const exchanges = recorder.snapshot();
      const outcome = outcomeForError(error, probe, expectation.verdict as "supported" | "unsupported" | "unknown", exchanges.at(-1));
      status = outcome.status;
      summary = outcome.summary;
      hint = outcome.hint;
      if (outcome.betaHeaderSuspect) facts.betaHeaderSuspect = true;
      if (!(err instanceof Anthropic.APIError) && !(err instanceof Anthropic.AnthropicError)) notes.push(`Thrown: ${err instanceof Error ? err.stack?.split("\n").slice(0, 3).join(" | ") : String(err)}`);
    }
  }

  const exchanges = recorder.snapshot();
  const usage = exchanges.reduce((u, e) => addUsage(u, e.usage), emptyUsage());
  facts.apiVersionSent ??= sentVersion(exchanges);
  return {
    id: probe.id,
    status,
    summary,
    hint,
    checks,
    notes,
    facts,
    error,
    expectation: expectation.reason,
    exchanges,
    usage,
    costUsd: estimateCost(profile.model, usage),
    startedAt: startedAt.toISOString(),
    durationMs: Math.round(performance.now() - t0),
  };
}

function skeleton(probe: ProbeDef, status: Status, summary: string, support: SupportView): ProbeResult {
  return {
    id: probe.id,
    status,
    summary,
    checks: [],
    notes: [],
    facts: {},
    expectation: support.expect(probe.feature).reason,
    exchanges: [],
    usage: emptyUsage(),
    costUsd: 0,
    startedAt: new Date().toISOString(),
    durationMs: 0,
  };
}

/** anthropic-version as actually sent: a header on the standard client, a body field on Vertex. */
function sentVersion(exchanges: Exchange[]): string | undefined {
  for (const e of exchanges) {
    const h = Object.entries(e.requestHeaders).find(([k]) => k.toLowerCase() === "anthropic-version")?.[1];
    if (h) return h;
    const body = e.requestBody as { anthropic_version?: unknown } | undefined;
    if (body && typeof body.anthropic_version === "string") return body.anthropic_version;
  }
  return undefined;
}

function verdictLine(c: Record<Status, number>, total: number): string {
  const ran = total - c["n/a"] - c.skipped;
  const problems = c.fail + c.blocked + c.error;
  if (ran === 0) return "Nothing ran.";
  if (problems === 0) return `All ${ran} applicable cases worked${c.warn ? ` (${c.warn} with caveats)` : ""}.`;
  return `${problems} of ${ran} applicable cases did not work: ${c.fail} failed, ${c.blocked} blocked by the gateway, ${c.error} transient errors.`;
}
