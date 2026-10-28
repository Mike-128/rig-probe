# Rig Probe: context for coding agents

Read this first. It covers what the project is, how it is put together, how to build and test it, the facts about the Anthropic SDK and gateways that cost real debugging time, and the invariants not to break. `README.md` is the user-facing guide; `docs/TEST-CASES.md` is the generated test case catalog.

## What it is

Rig Probe is a local web app (and CLI) that tests how much of the Anthropic TypeScript SDK works through a given target, usually an API gateway such as Azure API Management in front of either the Anthropic API ("1P") or Claude on Google Vertex AI. The user supplies a base URL, credential, and model. It runs documented test cases through the real SDK and writes an evidence pack (HTML, Markdown, JSON) per run.

The main goal is to tell gateway faults apart from platform and model limits. Every result is one of:

| Status | Meaning |
|---|---|
| `pass` | Worked as expected. |
| `warn` | Worked, with a caveat. |
| `fail` | Should have worked and did not. |
| `blocked` | The gateway refused the request: 401, 403, 405, or a 404 on a route. |
| `unsupported` | The model rejected the feature, which may be expected for that model. |
| `n/a` | The platform does not offer the feature, so nothing was sent. |
| `skipped` | Missing configuration, or the prerequisite case did not pass. |
| `error` | Transient: 429, 5xx, timeout, or a network failure. |

It is an offshoot of Rig (github.com/Mike-128/rig), a provider-agnostic agent harness, but shares no code with it.

## Commands

```bash
npm install          # Node >= 20; npm, not pnpm
npm start            # web app on http://localhost:7878 (tsx, no build step)
npm run mock         # mock gateway on 7879 (1P) and 7880 (Vertex); key "demo-key"
npm test             # vitest: unit, end-to-end against the mock, gateway faults, server API
npm run typecheck    # tsc --noEmit
npm run catalog      # regenerate docs/TEST-CASES.md from the case definitions
npm run probe -- run --preset anthropic-apim --base-url ... --model ...   # CLI; key in RIG_PROBE_KEY
```

There is no build step anywhere. The server runs TypeScript through `tsx`, and the web UI is plain HTML, CSS, and JavaScript in `web/`, served as-is. Keep it that way: the user's top requirement was "as simple as possible to run and use." `npm install` → `npm start` must stay the whole setup.

npm 12 blocks dependency install scripts by default. `package.json` has `allowScripts: { esbuild: false }`; tsx works without esbuild's postinstall.

## Layout

```
src/
  profile.ts          Target profile (zod schema), defaults, PRESETS, publicProfile() for evidence
  client.ts           buildClient(): the SDK client for a profile; all auth placement logic
  recorder.ts         fetch wrapper that captures every HTTP exchange, SSE chunk timing, and redacts
  pricing.ts          Per-family list prices for the cost estimate
  versions.ts         SDK and Node versions, recorded in every run
  probes/
    types.ts          ProbeSpec (the documented test case), ProbeContext, Status, defineProbe, SkipProbe
    support.ts        Platform availability and per-model feature support; live capability override
    classify.ts       Turns an SDK error into a status with a hint (the gateway-vs-model distinction)
    fixtures.ts       Generated PNG and PDF, citation document, cache prefix
    registry.ts       ALL_PROBES in report order; the prerequisite and model-info case IDs
    runner.ts         runProbes(): runs the cases, gates on the prerequisite, builds the RunRecord
    cases/*.ts        The test cases, one file per category
  evidence/
    findings.ts       Derives gateway-level conclusions from results
    html.ts, markdown.ts, catalog.ts, common.ts
    write.ts          Writes evidence/<runId>/{report.html, report.md, evidence.json}
  server/index.ts     Hono app: serves web/, REST + SSE API, evidence files; binds 127.0.0.1
  cli.ts              commander CLI (run, catalog, cases, presets)
web/                  index.html, app.js, style.css (no framework, no build)
test/
  mock-anthropic.ts   Mock API + gateway with fault switches; scripted replies for every case
  mock-server.ts      `npm run mock`
  *.test.ts           unit, e2e (both topologies), faults, server
docs/TEST-CASES.md    Generated. Do not edit by hand.
evidence/             Run output. Gitignored.
```

## The central abstraction: a probe

A probe is `defineProbe({ ...spec, run(ctx) })`. The spec (`ProbeSpec` in `probes/types.ts`) is the documented test case: ID, title, category, purpose, API surface, steps, expected result, betas, cost tier, opt-in, the `feature` it depends on, and `requires`. The spec is rendered verbatim into evidence reports and the catalog, so write it for a reader who is deciding whether their gateway works.

`run(ctx)` uses `ctx.client` (the SDK client, already wired to the recorder) and records outcomes with:

- `ctx.check(label, ok, detail)`: a required check. Any failure makes the case `fail`.
- `ctx.advise(label, ok, detail)`: an advisory check. A failure makes the case `warn`.
- `ctx.note(text)`: a note in the report. `ctx.fact(key, value)`: structured data that findings read.
- `ctx.label(text)`: labels the HTTP exchanges that follow.
- `ctx.makeClient({ auth, maxRetries, timeoutMs })`: another client, for example to try a different credential placement.
- `throw new SkipProbe(reason, status?)`: ends the case as skipped (or another status).

If `run` throws an SDK error, the runner classifies it with `outcomeForError()`, using the case's expectation from `support.expect(feature)`. A thrown non-SDK error is recorded as a `Thrown:` note. The e2e tests fail on any `Thrown:` note, because it means a bug in a case.

### Adding a test case

1. Add `defineProbe({...})` to the right file in `src/probes/cases/`. IDs are `TC-<CAT>-NN` and stable: never renumber, because evidence from earlier runs refers to them.
2. If it depends on a feature that is not everywhere, add it to `Feature` in `support.ts`, then to `PLATFORM_UNSUPPORTED` and/or `MODEL_SUPPORT`.
3. Teach `test/mock-anthropic.ts` to answer it, and run `npm test`. The e2e test requires every case to pass on the mock, or to be `unsupported` or `n/a` where expected.
4. Run `npm run catalog`.

Use `base(ctx)` from `cases/_util.ts` for model, `max_tokens`, and effort. It pins effort low where the model supports it, which keeps cost down.

## Runner behavior

- TC-CONN-01 is the prerequisite. It always runs first, even if not selected. If it does not pass, every other case is `skipped` and sends nothing.
- TC-CONN-03 loads the model's live capability report from the Models API, which then overrides the built-in support table (`support.setLive`).
- A case whose feature the platform lacks is `n/a`, with no request sent. Where the model is documented not to support a feature, a capability rejection is `unsupported`, not `fail`.
- Each case gets its own recorder and client, so its exchanges are its own evidence.
- One run at a time in the server (409 otherwise). Cancel stops after the current case.
- Each run has a nonce. Cache tests put it first in the prefix so they never read an earlier run's cache.

## Facts that cost debugging time

**SDK v1 auth.** `@anthropic-ai/sdk` 1.x sends `apiKey` as `Authorization: Bearer`; 0.x sent `X-Api-Key`. For a gateway that reads another header, use `defaultHeaders: { "<Header>": key, Authorization: null }`. Always pass `apiKey` explicitly: otherwise the client falls back to `ANTHROPIC_API_KEY` or a local profile and can leak an unrelated credential to the gateway. When the gateway's header is itself `Authorization` (say `Authorization: Token <key>`), do not also set `Authorization: null`. The later key wins and erases the credential (`client.ts` handles this, and a unit test covers it).

**The Vertex client** (`AnthropicVertex`) always calls `authClient.getRequestHeaders()`, and applies those headers after `defaultHeaders`, so `Authorization: null` cannot suppress them. Without `authClient`, it eagerly builds Google ADC and fails with "Failed to acquire Google OAuth credentials". Through a gateway, `client.ts` passes a stub `authClient` whose `getRequestHeaders()` returns the gateway credential. The Vertex client:

- rewrites requests to `{baseURL}/projects/P/locations/R/publishers/anthropic/models/M:rawPredict` (`:streamRawPredict` when streaming)
- sends token counting to `models/count-tokens:rawPredict`
- moves `anthropic-version` from the header into the body
- has no batches
- requires a region

**Beta requests** in SDK 1.3 go to plain `/v1/messages`, not `/v1/messages?beta=true`, with only the `anthropic-beta` header to mark them. (This was verified against the mock; earlier code assumed `?beta=true`, and that assumption was removed.) The tool runner adds its own beta header, `message-threads-2026-08-12`. A gateway that strips `anthropic-beta` shows up as a 400 naming an unknown field. `classify.ts` matches that and sets `betaHeaderSuspect`, which produces the "header stripped" finding.

**API version 2026-10-21** (sent by SDK 1.x):

- `temperature`, `top_p`, and `top_k` are rejected with a 400 on every model. TC-CONN-05 uses this to detect a gateway that rewrites `anthropic-version`.
- Document blocks in assistant turns are rejected.
- Citations on user text are rejected.

**Model-gated features.** These are encoded in `support.ts` `MODEL_SUPPORT`:

- Forced `tool_choice` (`any` or `tool`) is rejected on Opus 5.5, Sonnet 5.5, Fable 5.1, and Mythos 5.1.
- `budget_tokens` is rejected on the generation-5 models, Opus 4.8, and Opus 4.7.

**Prompt cache minimums** differ by model (512, 1024, 2048, or 4096 tokens). The table is `CACHE_MIN` in `support.ts`, and `cachePrefix()` aims for about 1.6 times the minimum.

**Platform gaps on Vertex AI.** Vertex does not offer: Files, Batches, the Models API, web fetch, code execution, the MCP connector, Agent Skills, fast mode, server fallbacks, cache diagnostics, or task budgets. Web search on Vertex is the basic `web_search_20250305` only.

**SSE buffering** is the most common gateway streaming fault. TC-STRM-03 flags it when a stream of at least 10 events arrives in no more than 2 network chunks, or when the spread between the first and last chunk is under 10% of the total time. In APIM, the fix is `buffer-response="false"` on `forward-request`.

## Invariants

- **No secret ever reaches disk, a report, or the browser beyond what the user typed.** The recorder redacts at capture: the configured auth header, any header whose name looks secret, secret-looking query parameters, and every literal occurrence of the key anywhere. `writeEvidence` scrubs any remaining occurrence before writing. The redaction marker shows the last 4 characters only for values of 16 characters or more. Tests assert that no key appears in any output.
- The CLI takes keys only from environment variables, never from flag values. The web UI keeps the key in memory and stores the profile in localStorage without it.
- The server binds to `127.0.0.1` only. `/evidence/:id/:file` serves only the three known filenames, and only for IDs matching `^[\w.-]+$`.
- Test case IDs are stable. Evidence and the catalog are generated from the specs; never hand-edit `docs/TEST-CASES.md`.
- `n/a` means nothing was sent. Do not send requests for features the platform lacks.
- Keep live runs cheap: a small `max_tokens` where possible, low effort, and slow or expensive cases opt-in. Ask before running anything against real credentials, because it spends the user's money.

## Testing

`test/mock-anthropic.ts` imitates both the Anthropic API and Vertex AI's rawPredict routes, behind a gateway with fault switches:

| Switch | Imitates |
|---|---|
| `bufferSse` | A gateway that buffers server-sent events |
| `stripBeta` | A gateway that drops the `anthropic-beta` header |
| `pinVersion` | A gateway that rewrites `anthropic-version` |
| `unrouted` | Routes the gateway does not forward |
| `stripResponseHeaders` | A gateway that strips request-id and rate-limit headers |
| `auth` | The only credential the gateway accepts |

It behaves like Claude Opus 5.5: it rejects sampling parameters, forced tool use, and `budget_tokens`. It verifies thinking signatures on replay, keeps a prompt cache, stores files, and runs batches. Its replies are scripted against the prompts the cases send, so changing a case's prompt can require a matching change in `compose()` or `answer()`.

There are no live tests, and no credentials in the repo. The user runs the tool against their own gateways.
