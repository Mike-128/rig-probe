import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateSync } from "node:zlib";
import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { buildClient } from "../src/client";
import { renderCatalog } from "../src/evidence/catalog";
import { classifyError, outcomeForError } from "../src/probes/classify";
import { codewordPdf, PDF_CODEWORD, solidPng } from "../src/probes/fixtures";
import { ALL_SPECS, defaultCaseIds } from "../src/probes/registry";
import { createSupport, modelFamily } from "../src/probes/support";
import { writeEvidence } from "../src/evidence/write";
import { runProbes } from "../src/probes/runner";
import { createRecorder, redacted } from "../src/recorder";
import { anthropicApim, APIM_HEADER, KEY, resolved } from "./helpers";
import { startMock } from "./mock-anthropic";

describe("fixtures", () => {
  it("builds a valid PNG of the requested size and color", () => {
    const png = solidPng(4, 3, [220, 20, 20]);
    expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    expect(png.readUInt32BE(16)).toBe(4);
    expect(png.readUInt32BE(20)).toBe(3);
    const idatAt = png.indexOf("IDAT") - 4;
    const raw = inflateSync(png.subarray(idatAt + 8, idatAt + 8 + png.readUInt32BE(idatAt)));
    expect(raw.length).toBe(3 * (1 + 4 * 3));
    expect([...raw.subarray(1, 4)]).toEqual([220, 20, 20]);
  });

  it("builds a PDF whose xref offsets point at its objects", () => {
    const pdf = codewordPdf().toString("latin1");
    expect(pdf).toContain(PDF_CODEWORD);
    const xref = Number(pdf.match(/startxref\n(\d+)/)![1]);
    expect(pdf.slice(xref, xref + 4)).toBe("xref");
    const offsets = [...pdf.slice(xref).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    offsets.forEach((off, i) => expect(pdf.slice(off).startsWith(`${i + 1} 0 obj`)).toBe(true));
  });
});

describe("registry", () => {
  it("has unique, well-formed IDs and a complete spec for every case", () => {
    const ids = ALL_SPECS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const s of ALL_SPECS) {
      expect(s.id).toMatch(/^TC-[A-Z]+-\d{2}$/);
      expect(s.purpose.length).toBeGreaterThan(20);
      expect(s.steps.length).toBeGreaterThan(0);
      expect(s.expected.length).toBeGreaterThan(5);
    }
  });

  it("leaves opt-in cases out of the standard set", () => {
    const defaults = defaultCaseIds();
    expect(defaults).not.toContain("TC-BATCH-02");
    expect(defaults).not.toContain("TC-BETA-11");
    expect(defaults).toContain("TC-CONN-01");
  });

  it("renders a catalog listing every case", () => {
    const md = renderCatalog();
    for (const s of ALL_SPECS) expect(md).toContain(s.id);
  });
});

describe("model support", () => {
  it.each([
    ["claude-opus-5-5", "opus-5-5"],
    ["claude-opus-5-5@20260101", "opus-5-5"],
    ["anthropic.claude-sonnet-4-6", "sonnet-4-6"],
    ["my-gateway-deployment", null],
  ])("normalizes %s", (input, family) => {
    expect(modelFamily(input)).toBe(family);
  });

  it("expects forced tool use to be rejected on Opus 5.5 and to work on Sonnet 4.6", () => {
    expect(createSupport("claude-opus-5-5", "anthropic").expect("forced_tool_choice").verdict).toBe("unsupported");
    expect(createSupport("claude-sonnet-4-6", "anthropic").expect("forced_tool_choice").verdict).toBe("supported");
  });

  it("marks platform gaps as n/a", () => {
    expect(createSupport("claude-opus-5-5", "vertex").expect("files").verdict).toBe("n/a");
    expect(createSupport("claude-opus-5-5", "anthropic").expect("files").verdict).toBe("supported");
  });

  it("has no expectation for unknown deployment names", () => {
    expect(createSupport("my-gateway-deployment", "anthropic").expect("effort").verdict).toBe("unknown");
  });

  it("prefers the live capability report over the built-in table", () => {
    const s = createSupport("claude-opus-5-5", "anthropic");
    s.setLive({ effort: { supported: false } });
    expect(s.expect("effort").verdict).toBe("unsupported");
  });
});

describe("error classification", () => {
  const spec = ALL_SPECS.find((s) => s.id === "TC-MSG-01")!;
  const apiError = (status: number, message: string) =>
    Anthropic.APIError.generate(status, { type: "error", error: { type: "invalid_request_error", message } }, message, new Headers());

  it("treats 401 as blocked by the gateway", () => {
    expect(outcomeForError(classifyError(apiError(401, "denied")), spec, "supported").status).toBe("blocked");
  });

  it("treats an unknown-field 400 as a stripped beta header", () => {
    const beta = ALL_SPECS.find((s) => s.id === "TC-BETA-01")!;
    const out = outcomeForError(classifyError(apiError(400, "context_management: Extra inputs are not permitted")), beta, "supported");
    expect(out.status).toBe("fail");
    expect(out.betaHeaderSuspect).toBe(true);
  });

  it("treats a documented capability rejection as unsupported", () => {
    const forced = ALL_SPECS.find((s) => s.id === "TC-TOOL-06")!;
    expect(outcomeForError(classifyError(apiError(400, "tool_choice any is not supported on this model")), forced, "unsupported").status).toBe("unsupported");
  });

  it("treats rate limits and 5xx as transient", () => {
    expect(outcomeForError(classifyError(apiError(429, "slow down")), spec, "supported").status).toBe("error");
    expect(outcomeForError(classifyError(apiError(503, "overloaded")), spec, "supported").status).toBe("error");
  });
});

describe("recorder", () => {
  it("redacts the key from headers, URLs, and bodies at capture time", async () => {
    const echo: typeof fetch = async () => new Response(JSON.stringify({ echoed: `key was ${KEY}` }), { headers: { "content-type": "application/json" } });
    const rec = createRecorder({ secrets: [KEY], sensitiveHeaders: [APIM_HEADER], baseFetch: echo });
    await rec.fetch(`https://gw.example/v1/messages?subscription-key=${KEY}`, {
      method: "POST",
      headers: { [APIM_HEADER]: KEY, "content-type": "application/json" },
      body: JSON.stringify({ note: `prefix ${KEY} suffix` }),
    });
    const [ex] = rec.snapshot();
    expect(JSON.stringify(ex)).not.toContain(KEY);
    expect(ex.requestHeaders[APIM_HEADER.toLowerCase()] ?? ex.requestHeaders[APIM_HEADER]).toMatch(/REDACTED/);
  });

  it("shows a key's last four characters only when the key is long", () => {
    expect(redacted(KEY)).toBe(`[REDACTED …${KEY.slice(-4)}]`);
    expect(redacted("demo")).toBe("[REDACTED]");
  });

  it("summarizes large base64 payloads instead of storing them", async () => {
    const rec = createRecorder({ secrets: [], baseFetch: async () => new Response("{}", { headers: { "content-type": "application/json" } }) });
    const data = Buffer.alloc(3000, 1).toString("base64");
    await rec.fetch("https://gw.example/v1/messages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ source: { data } }) });
    expect(JSON.stringify(rec.snapshot()[0].requestBody)).not.toContain(data);
  });
});

describe("client construction", () => {
  it.each([
    ["header", { mode: "header", headerName: APIM_HEADER }, APIM_HEADER.toLowerCase(), KEY],
    ["header with prefix", { mode: "header", headerName: "Authorization", prefix: "Token " }, "authorization", `Token ${KEY}`],
    ["x-api-key", { mode: "x-api-key" }, "x-api-key", KEY],
    ["bearer", { mode: "bearer" }, "authorization", `Bearer ${KEY}`],
  ] as const)("places the key for %s", async (_name, auth, header, value) => {
    const mock = await startMock();
    try {
      const profile = resolved(anthropicApim(mock, { auth }));
      await buildClient({ profile, secret: KEY }).messages.create({ model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "Reply with OK." }] });
      const sent = mock.requests[0].headers;
      expect(sent[header]).toBe(value);
      const others = ["authorization", "x-api-key", APIM_HEADER.toLowerCase()].filter((h) => h !== header);
      for (const h of others) expect(sent[h]).toBeUndefined();
    } finally {
      await mock.close();
    }
  });

  it("ignores ANTHROPIC_API_KEY from the environment", async () => {
    const mock = await startMock();
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = "sk-from-environment";
    try {
      const profile = resolved(anthropicApim(mock));
      await buildClient({ profile, secret: KEY }).messages.create({ model: "claude-opus-5-5", max_tokens: 16, messages: [{ role: "user", content: "Reply with OK." }] });
      expect(JSON.stringify(mock.requests[0].headers)).not.toContain("sk-from-environment");
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
      await mock.close();
    }
  });
});

describe("evidence", () => {
  it("scrubs a short key even where it appears in user-typed target fields", async () => {
    const mock = await startMock({ auth: { header: APIM_HEADER, value: "demo" } });
    const dir = mkdtempSync(path.join(tmpdir(), "rig-probe-unit-"));
    try {
      const profile = anthropicApim(mock, { name: "demo gateway", vertex: undefined });
      const run = await runProbes({ profile, secret: "demo", caseIds: ["TC-CONN-01"] });
      expect(run.results[0].status).toBe("pass");
      const paths = writeEvidence(run, "demo", dir);
      for (const f of [paths.json, paths.markdown, paths.html]) expect(readFileSync(f, "utf8")).not.toContain("demo");
    } finally {
      await mock.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
