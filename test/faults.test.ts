import { afterEach, describe, expect, it } from "vitest";
import { runProbes } from "../src/probes/runner";
import { anthropicApim, APIM_HEADER, KEY, vertexApim } from "./helpers";
import { type Mock, type MockOptions, startMock } from "./mock-anthropic";

/** Each test reproduces one gateway fault and checks the tool names it, rather than just failing. */
describe("gateway faults are diagnosed", () => {
  let mock: Mock | undefined;
  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  async function run(opts: MockOptions, caseIds: string[], dialect: "anthropic" | "vertex" = "anthropic") {
    mock = await startMock({ dialect, auth: { header: APIM_HEADER, value: KEY }, ...opts });
    const profile = dialect === "vertex" ? vertexApim(mock) : anthropicApim(mock);
    const record = await runProbes({ profile, secret: KEY, caseIds });
    const byId = Object.fromEntries(record.results.map((r) => [r.id, r]));
    return { record, byId, titles: record.findings.map((f) => f.title) };
  }

  it("buffered server-sent events", async () => {
    const { byId, titles } = await run({ bufferSse: true, eventDelayMs: 3 }, ["TC-STRM-03"]);
    expect(byId["TC-STRM-03"].status).toBe("warn");
    expect(byId["TC-STRM-03"].facts.sseBuffered).toBe(true);
    expect(titles).toContain("The gateway buffers streaming responses");
  });

  it("incremental server-sent events are reported as such", async () => {
    const { byId, titles } = await run({ eventDelayMs: 3 }, ["TC-STRM-03"]);
    expect(byId["TC-STRM-03"].status).toBe("pass");
    expect(titles).toContain("Streaming is delivered incrementally");
  });

  it.each(["anthropic", "vertex"] as const)("anthropic-beta header stripped (%s)", async (dialect) => {
    const { byId, titles } = await run({ stripBeta: true }, ["TC-BETA-01", "TC-BETA-06"], dialect);
    expect(byId["TC-BETA-01"].status).toBe("fail");
    expect(byId["TC-BETA-01"].hint).toMatch(/anthropic-beta header/);
    expect(titles).toContain("The anthropic-beta header appears to be stripped");
  });

  it("anthropic-version rewritten in transit", async () => {
    const { byId, titles } = await run({ pinVersion: "2023-06-01" }, ["TC-CONN-05"]);
    expect(byId["TC-CONN-05"].status).toBe("fail");
    expect(byId["TC-CONN-05"].facts.apiVersionHonored).toBe(false);
    expect(titles).toContain("The API version may be rewritten in transit");
  });

  it("endpoints the gateway does not route are blocked, not failed", async () => {
    const { byId, record } = await run({ unrouted: ["/v1/files", "/v1/messages/batches"] }, ["TC-FILE-01", "TC-BATCH-01"]);
    expect(byId["TC-FILE-01"].status).toBe("blocked");
    expect(byId["TC-BATCH-01"].status).toBe("blocked");
    expect(byId["TC-FILE-01"].hint).toMatch(/does not route \/anthropic\/v1\/files/);
    expect(record.findings.find((f) => f.title === "Requests refused by the gateway")?.cases).toEqual(["TC-BATCH-01", "TC-FILE-01"]);
  });

  it("stripped request-id and rate-limit headers", async () => {
    const { byId, titles } = await run({ stripResponseHeaders: true }, ["TC-SDK-03"]);
    expect(byId["TC-SDK-03"].status).toBe("warn");
    expect(titles).toContain("Request IDs are not returned");
  });

  it("a rejected key blocks the run at the prerequisite and spends nothing else", async () => {
    const { byId, record, titles } = await run({ auth: { header: APIM_HEADER, value: "a-different-key" } }, ["TC-MSG-01", "TC-TOOL-01"]);
    expect(byId["TC-CONN-01"].status).toBe("blocked");
    expect(byId["TC-MSG-01"].status).toBe("skipped");
    expect(byId["TC-TOOL-01"].exchanges).toEqual([]);
    expect(record.summary.counts.blocked).toBe(1);
    expect(titles).toContain("The SDK cannot reach the model through this target");
  });

  it("credential discovery reports which placements the gateway accepts", async () => {
    const { byId } = await run({}, ["TC-CONN-02"]);
    const placements = byId["TC-CONN-02"].facts.authPlacements as { placement: string; accepted: boolean }[];
    expect(placements.map((p) => p.accepted)).toEqual([true, false, false]);
    expect(byId["TC-CONN-02"].notes.join(" ")).toMatch(/rejects the SDK v1 default/);
  });
});
