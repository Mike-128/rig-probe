import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { anthropicApim, APIM_HEADER, KEY } from "./helpers";
import { type Mock, startMock } from "./mock-anthropic";

const dir = mkdtempSync(path.join(tmpdir(), "rig-probe-server-"));
process.env.RIG_PROBE_EVIDENCE_DIR = dir;
const { createApp } = await import("../src/server/index");

describe("web server", () => {
  let mock: Mock;
  const app = createApp();

  beforeAll(async () => {
    mock = await startMock({ auth: { header: APIM_HEADER, value: KEY } });
  });
  afterAll(async () => {
    await mock.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("serves the UI and its metadata", async () => {
    expect((await app.request("/")).status).toBe(200);
    expect((await app.request("/app.js")).headers.get("content-type")).toMatch(/javascript/);
    const meta = await (await app.request("/api/meta")).json();
    expect(meta.presets.map((p: { id: string }) => p.id)).toEqual(expect.arrayContaining(["anthropic-apim", "vertex-apim"]));
    expect(meta.cases.length).toBeGreaterThan(60);
    expect(meta.cases[0].availability).toEqual({ anthropic: true, vertex: true });
  });

  it("rejects an incomplete target with field-level issues", async () => {
    const res = await app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: { name: "x" }, key: KEY }) });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.issues.map((i: { path: string }) => i.path)).toEqual(expect.arrayContaining(["baseUrl", "model"]));
  });

  it("requires a key for key-based auth", async () => {
    const res = await app.request("/api/runs", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ profile: anthropicApim(mock), key: "" }) });
    expect(res.status).toBe(400);
  });

  it("runs, streams progress, and serves the evidence without the key", async () => {
    const start = await app.request("/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ profile: anthropicApim(mock), key: KEY, caseIds: ["TC-MSG-01", "TC-TOOL-01"] }),
    });
    expect(start.status).toBe(202);
    const { id } = await start.json();

    const events = await (await app.request(`/api/runs/${id}/events`)).text();
    const types = [...events.matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(types[0]).toBe("run_started");
    expect(types.at(-1)).toBe("run_finished");
    expect(types.filter((t) => t === "case_finished")).toHaveLength(3);
    expect(events).not.toContain(KEY);

    for (const file of ["report.html", "report.md", "evidence.json"]) {
      const res = await app.request(`/evidence/${id}/${file}`);
      expect(res.status).toBe(200);
      expect(await res.text()).not.toContain(KEY);
    }
    const runs = await (await app.request("/api/runs")).json();
    expect(runs[0].id).toBe(id);
  });

  it("serves only the evidence files, nothing else on disk", async () => {
    expect((await app.request("/evidence/..%2F..%2Fpackage.json/report.html")).status).toBe(404);
    expect((await app.request("/evidence/x/secrets.txt")).status).toBe(404);
  });
});
