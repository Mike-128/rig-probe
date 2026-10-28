import { serve, type ServerType } from "@hono/node-server";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STATUS_INFO } from "../evidence/common";
import { EVIDENCE_DIR, listRuns, writeEvidence } from "../evidence/write";
import { PRESETS, ProfileSchema } from "../profile";
import { ALL_SPECS, defaultCaseIds } from "../probes/registry";
import { makeRunId, type RunEvent, type RunRecord, runProbes } from "../probes/runner";
import { platformAvailability } from "../probes/support";
import type { ProbeResult } from "../probes/types";
import { CATEGORIES } from "../probes/types";
import { environment } from "../versions";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(HERE, "../../web");

type UiEvent =
  | Exclude<RunEvent, { type: "run_finished" | "case_finished" }>
  | { type: "case_finished"; result: ProbeResult; index: number; total: number }
  | { type: "run_finished"; summary: RunRecord["summary"]; findings: RunRecord["findings"]; id: string; evidence: Record<string, string>; evidenceDir: string }
  | { type: "run_failed"; error: string };

interface LiveRun {
  id: string;
  events: UiEvent[];
  listeners: Set<(e: UiEvent) => void>;
  controller: AbortController;
  done: boolean;
}

const runs = new Map<string, LiveRun>();
let active: LiveRun | undefined;

/** Results for the browser: HTTP bodies stay in the evidence files, which the UI links to. */
function slim(result: ProbeResult): ProbeResult {
  return {
    ...result,
    exchanges: result.exchanges.map(({ seq, label, method, url, status, ttfbMs, durationMs, stream, error, startedAt, requestHeaders }) => ({
      seq,
      label,
      method,
      url,
      status,
      ttfbMs,
      durationMs,
      stream,
      error,
      startedAt,
      requestHeaders,
    })),
  };
}

const evidenceLinks = (id: string) => ({
  html: `/evidence/${encodeURIComponent(id)}/report.html`,
  markdown: `/evidence/${encodeURIComponent(id)}/report.md`,
  json: `/evidence/${encodeURIComponent(id)}/evidence.json`,
});

export function createApp(): Hono {
  const app = new Hono();

  const asset = (file: string, type: string) => (c: import("hono").Context) => {
    const p = path.join(WEB_DIR, file);
    if (!existsSync(p)) return c.text("not found", 404);
    return c.body(readFileSync(p), 200, { "content-type": type, "cache-control": "no-store" });
  };
  app.get("/", asset("index.html", "text/html; charset=utf-8"));
  app.get("/app.js", asset("app.js", "text/javascript; charset=utf-8"));
  app.get("/style.css", asset("style.css", "text/css; charset=utf-8"));

  app.get("/api/meta", (c) =>
    c.json({
      presets: PRESETS,
      categories: CATEGORIES,
      cases: ALL_SPECS.map((s) => ({ ...s, availability: platformAvailability(s.feature) })),
      defaults: defaultCaseIds(),
      statuses: STATUS_INFO,
      environment: environment(),
      evidenceDir: EVIDENCE_DIR,
      busy: Boolean(active && !active.done),
    }),
  );

  app.post("/api/runs", async (c) => {
    if (active && !active.done) return c.json({ error: "A run is already in progress. Wait for it or cancel it." }, 409);
    const body = (await c.req.json().catch(() => ({}))) as { profile?: unknown; key?: unknown; caseIds?: unknown };
    const parsed = ProfileSchema.safeParse(body.profile);
    if (!parsed.success) {
      return c.json({ error: "The target settings are incomplete.", issues: parsed.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })) }, 400);
    }
    const key = typeof body.key === "string" ? body.key.trim() : "";
    const needsKey = !["google-adc", "none"].includes(parsed.data.auth.mode);
    if (needsKey && !key) return c.json({ error: "Enter the key for this target." }, 400);
    const caseIds = Array.isArray(body.caseIds) ? body.caseIds.filter((x): x is string => typeof x === "string") : undefined;

    const id = makeRunId(parsed.data.name);
    const run: LiveRun = { id, events: [], listeners: new Set(), controller: new AbortController(), done: false };
    runs.set(id, run);
    active = run;
    const emit = (e: UiEvent) => {
      run.events.push(e);
      for (const l of run.listeners) l(e);
    };

    void (async () => {
      try {
        const record = await runProbes({
          profile: parsed.data,
          secret: key,
          caseIds,
          id,
          signal: run.controller.signal,
          onEvent: (e) => {
            if (e.type === "case_finished") emit({ ...e, result: slim(e.result) });
            else if (e.type !== "run_finished") emit(e);
          },
        });
        const paths = writeEvidence(record, key);
        emit({ type: "run_finished", id, summary: record.summary, findings: record.findings, evidence: evidenceLinks(id), evidenceDir: paths.dir });
      } catch (err) {
        emit({ type: "run_failed", error: err instanceof Error ? err.message : String(err) });
      } finally {
        run.done = true;
        for (const l of run.listeners) l({ type: "run_failed", error: "__closed__" });
      }
    })();
    return c.json({ id }, 202);
  });

  app.get("/api/runs/:id/events", (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run) return c.json({ error: "No such run in this session." }, 404);
    return streamSSE(c, async (stream) => {
      const queue: UiEvent[] = [...run.events];
      let wake: (() => void) | undefined;
      const listener = (e: UiEvent) => {
        queue.push(e);
        wake?.();
      };
      run.listeners.add(listener);
      stream.onAbort(() => {
        run.listeners.delete(listener);
        wake?.();
      });
      try {
        while (!stream.aborted) {
          while (queue.length) {
            const e = queue.shift()!;
            if (e.type === "run_failed" && e.error === "__closed__") return;
            await stream.writeSSE({ event: e.type, data: JSON.stringify(e) });
          }
          if (run.done) return;
          await new Promise<void>((r) => (wake = r));
          wake = undefined;
        }
      } finally {
        run.listeners.delete(listener);
      }
    });
  });

  app.post("/api/runs/:id/cancel", (c) => {
    const run = runs.get(c.req.param("id"));
    if (!run || run.done) return c.json({ error: "Not running." }, 404);
    run.controller.abort();
    return c.json({ ok: true, note: "The case in progress will finish; no further cases will start." });
  });

  app.get("/api/runs", (c) => c.json(listRuns()));

  app.get("/evidence/:id/:file", (c) => {
    const id = c.req.param("id");
    const file = c.req.param("file");
    const types: Record<string, string> = { "report.html": "text/html; charset=utf-8", "report.md": "text/markdown; charset=utf-8", "evidence.json": "application/json; charset=utf-8" };
    if (!/^[\w.-]+$/.test(id) || !types[file]) return c.text("not found", 404);
    const p = path.join(EVIDENCE_DIR, id, file);
    if (!existsSync(p)) return c.text("not found", 404);
    return c.body(readFileSync(p), 200, { "content-type": types[file] });
  });

  return app;
}

function listen(app: Hono, port: number): Promise<{ server: ServerType; port: number }> {
  return new Promise((resolve, reject) => {
    const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port }, (info) => resolve({ server, port: info.port }));
    server.once("error", reject);
  });
}

function openBrowser(url: string): void {
  if (process.env.RIG_PROBE_NO_OPEN || process.env.CI) return;
  const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    spawn(cmd[0] as string, cmd[1] as string[], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* the URL is printed anyway */
  }
}

async function main(): Promise<void> {
  const app = createApp();
  const first = Number(process.env.RIG_PROBE_PORT ?? 7878);
  for (let port = first; port < first + 10; port++) {
    try {
      const { port: bound } = await listen(app, port);
      const url = `http://localhost:${bound}`;
      console.log(`\n  Rig Probe is running at ${url}\n`);
      console.log(`  Evidence is written to ${EVIDENCE_DIR}`);
      console.log("  Press Ctrl+C to stop.\n");
      openBrowser(url);
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE") throw err;
    }
  }
  throw new Error(`No free port between ${first} and ${first + 9}. Set RIG_PROBE_PORT to choose another.`);
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
