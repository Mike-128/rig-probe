# Rig Probe

Find out which Anthropic SDK features work through your API gateway and model, and get a documented evidence report for each test case.

You enter the gateway URL, the key, and the model. Rig Probe runs 66 test cases through the official Anthropic TypeScript SDK (`@anthropic-ai/sdk` 1.3, `@anthropic-ai/vertex-sdk` 1.1): messages, streaming, images and PDFs, tool calls, structured outputs, thinking, prompt caching, token counting, server tools, batches, files, SDK error handling, and the `anthropic-beta` features. Each case is reported as pass, fail, or one of a few more specific outcomes, with the HTTP exchanges behind it.

It is built for these two topologies:

- **Anthropic 1P > APIM**: Azure API Management in front of `api.anthropic.com`
- **Anthropic via GCP > APIM**: Azure API Management in front of Claude on Google Vertex AI

It also covers either provider directly, with no gateway, as a baseline for comparison.

## Run it

You need [Node.js](https://nodejs.org) 20 or later.

```bash
npm install
```

```bash
npm start
```

Your browser opens at http://localhost:7878. Then:

1. **Target.** Pick the preset for your topology, then fill in the gateway base URL, model, and key. For Vertex, also fill in the GCP project and region.
2. **Test cases.** The standard set is already selected. Cases your platform does not offer (for example the Files API on Vertex) are marked and reported as N/A without sending anything.
3. **Run.** Results stream in as each case finishes. Click any row for its checks and HTTP exchanges.
4. **Evidence.** When the run ends, click **Open evidence report**. Every run is saved under `evidence/<run-id>/`.

The key stays in memory for the run only. It is never written to disk, and every report redacts it.

### Try it without credentials

A mock gateway is included. It imitates APIM in front of `claude-opus-5-5`, and nothing leaves your machine. In one terminal:

```bash
npm run mock
```

In another:

```bash
npm start
```

Use the base URL the mock prints, the key `demo-key`, and the model `claude-opus-5-5`.

## Setting up the target

| | Anthropic 1P > APIM | Anthropic via GCP > APIM |
|---|---|---|
| Preset | Anthropic 1P via APIM | Google Vertex AI via APIM (Vertex routes) |
| Base URL | The APIM URL mapped to `https://api.anthropic.com`, without `/v1` | The APIM URL mapped to `https://REGION-aiplatform.googleapis.com/v1` |
| Model | e.g. `claude-opus-5-5` | e.g. `claude-opus-5-5` |
| Key | APIM subscription key | APIM subscription key |
| Also needed | | GCP project ID and region (`global`, `us`, `eu`, or a specific region) |

If your APIM accepts Anthropic-shaped `/v1/messages` requests and translates them to Vertex itself, use the preset **Google Vertex AI via APIM (APIM exposes /v1/messages)** instead.

The presets send the key in `Ocp-Apim-Subscription-Key`. If your gateway expects it elsewhere, change **Credential placement**. Test case TC-CONN-02 checks which placements your gateway accepts.

To show what the gateway changes, run the same model through the direct preset (**Anthropic 1P direct** or **Google Vertex AI direct**) and compare the two reports.

## Reading the results

| Result | Meaning |
|---|---|
| Pass | Worked as expected. |
| Warn | Worked, with a caveat worth reading. |
| Fail | Should have worked and did not. |
| Blocked | The gateway refused the request: authentication failed, the route was not found, or the method was not allowed. |
| Unsupported | The model rejected the feature. This is expected where the model is documented not to support it, for example forced tool use on Claude Opus 5.5. |
| Error | Transient: network, timeout, rate limit, or server error. Re-run before concluding anything. |
| N/A | The upstream platform does not offer this feature, so nothing was sent. |
| Skipped | Missing configuration, or the first case (TC-CONN-01) did not pass. |

The report's **Findings** section turns individual results into gateway conclusions, for example:

- The gateway buffers streaming responses.
- The gateway strips the `anthropic-beta` header.
- The gateway rewrites `anthropic-version`.
- The gateway does not route `/v1/files`.
- The gateway rejects the SDK v1 default `Authorization: Bearer`.

Each finding links to the cases behind it.

Every run writes three files:

| File | Use |
|---|---|
| `report.html` | The evidence report. Self-contained, and prints to PDF with every case expanded. |
| `report.md` | The same report as Markdown, for tickets and wikis. |
| `evidence.json` | Everything, machine-readable: specs, checks, and redacted request and response bodies. |

The full test case catalog is in [docs/TEST-CASES.md](docs/TEST-CASES.md).

## Cost

Each case sends one to four small requests. A full standard run costs well under a dollar on current models, and the report shows the estimate. Two slower or more expensive cases are opt-in: TC-BATCH-02 (waits for a batch to complete) and TC-BETA-11 (Agent Skills in a code execution container).

## Command line

The same test cases run without the browser, for CI or scripting. The key comes from an environment variable, never a flag.

```bash
export RIG_PROBE_KEY=your-apim-key
npx tsx src/cli.ts run --preset anthropic-apim --base-url https://your-apim.azure-api.net/anthropic --model claude-opus-5-5
```

`npm run probe -- presets` lists the presets, and `npm run probe -- cases` lists the test cases. The command exits with status 1 if any case failed, was blocked, or errored.

## Settings

| Environment variable | Default | |
|---|---|---|
| `RIG_PROBE_PORT` | `7878` | Port for the app. |
| `RIG_PROBE_EVIDENCE_DIR` | `./evidence` | Where reports are written. |
| `RIG_PROBE_NO_OPEN` | | Set to anything to stop the browser from opening. |

## Development

```bash
npm test
```

```bash
npm run typecheck
```

The tests run every case against the mock gateway in both topologies, and reproduce each gateway fault the tool detects. See [AGENTS.md](AGENTS.md) for the architecture and how to add a test case.

## License

MIT
