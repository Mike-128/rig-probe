import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { writeEvidence } from "../src/evidence/write";
import { ALL_SPECS } from "../src/probes/registry";
import { type RunRecord, runProbes } from "../src/probes/runner";
import { anthropicApim, APIM_HEADER, KEY, vertexApim } from "./helpers";
import { type Mock, startMock } from "./mock-anthropic";

// Every case except the batch completion one, which polls on a 10-second interval.
const EVERY_CASE = ALL_SPECS.filter((s) => s.id !== "TC-BATCH-02").map((s) => s.id);
const EXPECTED_UNSUPPORTED = ["TC-TOOL-06", "TC-TOOL-07", "TC-THINK-03"];

const internalErrors = (run: RunRecord) => run.results.filter((r) => r.notes.some((n) => n.startsWith("Thrown:"))).map((r) => `${r.id}: ${r.notes.join(" ")}`);

describe.each([
  ["Anthropic 1P > APIM", "anthropic", anthropicApim],
  ["Anthropic via GCP > APIM", "vertex", vertexApim],
] as const)("full run: %s", (_label, dialect, makeProfile) => {
  let mock: Mock;
  let run: RunRecord;
  let dir: string;

  beforeAll(async () => {
    mock = await startMock({ dialect, auth: { header: APIM_HEADER, value: KEY } });
    run = await runProbes({ profile: makeProfile(mock), secret: KEY, caseIds: EVERY_CASE });
    dir = mkdtempSync(path.join(tmpdir(), "rig-probe-e2e-"));
  }, 120_000);

  afterAll(async () => {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs every case without an internal error", () => {
    expect(internalErrors(run)).toEqual([]);
  });

  it("passes everything the platform offers, and classifies the rest", () => {
    const notPassing = run.results.filter((r) => r.status !== "pass").map((r) => `${r.id}:${r.status}`);
    const expected = run.results
      .filter((r) => r.status !== "pass")
      .map((r) => {
        if (EXPECTED_UNSUPPORTED.includes(r.id)) return `${r.id}:unsupported`;
        if (r.id === "TC-BETA-10" && dialect === "anthropic") return `${r.id}:skipped`;
        return `${r.id}:n/a`;
      });
    expect(notPassing).toEqual(expected);
    expect(run.summary.counts.fail + run.summary.counts.blocked + run.summary.counts.error).toBe(0);
  });

  it("sends nothing for features the platform lacks", () => {
    const na = run.results.filter((r) => r.status === "n/a");
    expect(na.every((r) => r.exchanges.length === 0)).toBe(true);
    if (dialect === "vertex") expect(na.map((r) => r.id)).toEqual(expect.arrayContaining(["TC-FILE-01", "TC-BATCH-01", "TC-SRV-02", "TC-CONN-03"]));
    else expect(na).toEqual([]);
  });

  it("puts the key only in the configured header, never in Authorization", () => {
    const main = mock.requests.filter((r) => r.headers[APIM_HEADER.toLowerCase()] === KEY);
    expect(main.length).toBeGreaterThan(40);
    for (const r of main) expect(r.headers.authorization).toBeUndefined();
  });

  it("uses the routes of the topology", () => {
    const paths = mock.requests.map((r) => r.path);
    if (dialect === "vertex") {
      expect(paths.some((p) => p.endsWith("/publishers/anthropic/models/claude-opus-5-5:rawPredict"))).toBe(true);
      expect(paths.some((p) => p.endsWith(":streamRawPredict"))).toBe(true);
      expect(paths.some((p) => p.endsWith("/models/count-tokens:rawPredict"))).toBe(true);
    } else {
      expect(paths.some((p) => p === "/anthropic/v1/messages")).toBe(true);
      expect(paths.some((p) => p.startsWith("/anthropic/v1/files"))).toBe(true);
    }
  });

  it("writes an evidence pack that documents each case and never contains the key", () => {
    const paths = writeEvidence(run, KEY, dir);
    const html = readFileSync(paths.html, "utf8");
    const md = readFileSync(paths.markdown, "utf8");
    const json = readFileSync(paths.json, "utf8");
    for (const body of [html, md, json]) expect(body).not.toContain(KEY);
    for (const r of run.results) {
      expect(md).toContain(r.id);
      expect(html).toContain(r.id);
    }
    expect(md).toContain("Expected");
    expect(json).toContain(`[REDACTED …${KEY.slice(-4)}]`);
    expect(JSON.parse(json).schema).toBe("rig-probe/run@1");
  });
});
