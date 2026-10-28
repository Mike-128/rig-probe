// Rig Probe UI. Plain JavaScript, no build step: the server serves this file as-is.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const store = {
  get(k, fallback) {
    try { const v = localStorage.getItem(`rig-probe.${k}`); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(k, v) {
    try { localStorage.setItem(`rig-probe.${k}`, JSON.stringify(v)); } catch { /* storage unavailable */ }
  },
};

let meta;
let profile;
let key = "";
let selected = new Set();
let runId;
let source;
const results = new Map();

const AUTH_OPTIONS = [
  ["header", "Named header (e.g. APIM subscription key)"],
  ["bearer", "Authorization: Bearer (SDK v1 default)"],
  ["x-api-key", "X-Api-Key (SDK v0 default)"],
  ["google-adc", "Google Application Default Credentials (Vertex direct)"],
  ["none", "None (gateway injects the credential)"],
];

// ---- target form ----------------------------------------------------------

const get = (obj, path) => path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
function set(obj, path, value) {
  const keys = path.split(".");
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] ??= {};
  o[keys.at(-1)] = value;
}

const needsKey = () => !["google-adc", "none"].includes(profile.auth?.mode);

const FIELDS = [
  { path: "name", label: "Target name", hint: "Appears as the report title." },
  { path: "platform", label: "Upstream platform", type: "select", options: [["anthropic", "Anthropic API (1P)"], ["vertex", "Google Vertex AI"]], hint: "What actually serves the model. Decides which features exist, so a missing feature is not blamed on the gateway." },
  { path: "client", label: "SDK client", type: "select", options: [["anthropic", "Standard client (/v1/messages)"], ["vertex", "Vertex client (Vertex AI routes)"]], hint: "Match what the gateway exposes: Anthropic-shaped /v1/messages, or Vertex AI's own …:rawPredict routes." },
  { path: "baseUrl", label: "Base URL", hint: "The URL the SDK sends to. For APIM, the gateway URL mapped to the provider." },
  { path: "model", label: "Model", hint: "Model ID, or the deployment name the gateway expects." },
  { path: "auth.mode", label: "Credential placement", type: "select", options: AUTH_OPTIONS },
  { path: "auth.headerName", label: "Header name", show: () => profile.auth?.mode === "header" },
  { path: "auth.prefix", label: "Header value prefix (optional)", show: () => profile.auth?.mode === "header", hint: "Text placed before the key, if the gateway expects one." },
  { path: "__key", label: "Key", type: "password", show: needsKey, hint: "Gateway subscription key or API key." },
  { path: "vertex.projectId", label: "GCP project ID", show: () => profile.client === "vertex" },
  { path: "vertex.region", label: "GCP region", show: () => profile.client === "vertex", hint: "global, us, eu, or a specific region. Part of the request path." },
];

const ADVANCED = [
  { path: "extraHeaders", label: "Extra request headers", type: "pairs", sep: ":", hint: "One per line: Name: value. Values that look secret are redacted in reports." },
  { path: "query", label: "Extra query parameters", type: "pairs", sep: "=", hint: "One per line: name=value, e.g. api-version=2025-01-01." },
  { path: "apiVersion", label: "anthropic-version override", hint: "Blank uses the SDK default (2026-10-21 on SDK v1)." },
  { path: "timeoutSec", label: "Request timeout (seconds)", type: "number" },
  { path: "batchTimeoutSec", label: "Batch completion timeout (seconds)", type: "number", hint: "Only for the opt-in batch completion case." },
  { path: "imageUrl", label: "Image URL for TC-MM-02", hint: "Blank uses a public Wikimedia image of dice." },
  { path: "mcpServerUrl", label: "MCP server URL for TC-BETA-10", hint: "Must be reachable from Anthropic's servers. Blank skips the case." },
  { path: "mcpServerName", label: "MCP server name" },
];

function fieldHtml(f) {
  if (f.show && !f.show()) return "";
  const id = `f-${f.path}`;
  let value = f.path === "__key" ? key : get(profile, f.path);
  let input;
  if (f.type === "select") {
    input = `<select id="${id}" data-path="${f.path}">${f.options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>`;
  } else if (f.type === "pairs") {
    const text = Object.entries(value ?? {}).map(([k, v]) => `${k}${f.sep === ":" ? ": " : "="}${v}`).join("\n");
    input = `<textarea id="${id}" data-path="${f.path}" data-sep="${f.sep}" spellcheck="false">${esc(text)}</textarea>`;
  } else if (f.type === "password") {
    input = `<div class="keyrow"><input id="${id}" type="password" data-path="${f.path}" value="${esc(value ?? "")}" spellcheck="false"><button type="button" class="ghost" id="reveal">Show</button></div>`;
  } else {
    input = `<input id="${id}" type="${f.type === "number" ? "number" : "text"}" data-path="${f.path}" value="${esc(value ?? "")}" spellcheck="false">`;
  }
  return `<label class="field" data-field="${f.path}"><span>${esc(f.label)}</span>${input}${f.hint ? `<span class="hint">${esc(f.hint)}</span>` : ""}</label>`;
}

function renderForm() {
  $("#target-form").innerHTML = FIELDS.map(fieldHtml).join("");
  $("#advanced-form").innerHTML = ADVANCED.map(fieldHtml).join("");
  $("#reveal")?.addEventListener("click", (e) => {
    const input = $("#f-__key");
    input.type = input.type === "password" ? "text" : "password";
    e.target.textContent = input.type === "password" ? "Show" : "Hide";
  });
}

function onFieldChange(e) {
  const el = e.target;
  const path = el.dataset.path;
  if (!path) return;
  if (path === "__key") { key = el.value; return; }
  let value = el.value;
  if (el.dataset.sep) {
    const out = {};
    for (const line of value.split("\n")) {
      const i = line.indexOf(el.dataset.sep);
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    }
    value = out;
  } else if (el.type === "number") {
    value = el.value ? Number(el.value) : undefined;
  } else if (value === "" && path !== "name") {
    value = undefined;
  }
  set(profile, path, value);
  // Keep combinations valid: the Vertex client only talks to Vertex.
  if (path === "client" && value === "vertex") {
    profile.platform = "vertex";
    profile.vertex ??= { projectId: "", region: "global" };
  }
  if (path === "platform" && value === "anthropic" && profile.client === "vertex") profile.client = "anthropic";
  store.set("profile", profile);
  if (el.tagName === "SELECT") { renderForm(); renderCases(); }
}

function applyPreset(id) {
  const preset = meta.presets.find((p) => p.id === id);
  if (!preset) return;
  profile = structuredClone(preset.profile);
  $("#preset-help").textContent = preset.description;
  store.set("profile", profile);
  store.set("preset", id);
  renderForm();
  renderCases();
}

// ---- test case selection --------------------------------------------------

const applicable = (c) => c.availability[profile.platform] !== false;

function renderCases() {
  const groups = meta.categories.map((cat) => ({ cat, cases: meta.cases.filter((c) => c.category === cat.id) })).filter((g) => g.cases.length);
  const open = store.get("openCats", ["connectivity"]);
  $("#cases").innerHTML = groups.map(({ cat, cases }) => {
    const n = cases.filter((c) => selected.has(c.id) && applicable(c)).length;
    return `<details class="cat" data-cat="${cat.id}" ${open.includes(cat.id) ? "open" : ""}>
      <summary><input type="checkbox" data-cat-toggle="${cat.id}" ${n === cases.filter(applicable).length && n ? "checked" : ""}> <b>${esc(cat.label)}</b><span class="count">${n} of ${cases.length}</span></summary>
      <p class="blurb">${esc(cat.blurb)}</p>
      ${cases.map(caseRow).join("")}
    </details>`;
  }).join("");
  updateSummary();
}

function caseRow(c) {
  const na = !applicable(c);
  const tags = [
    na ? `<span class="tag na" title="Not offered on ${profile.platform === "vertex" ? "Google Vertex AI" : "the Anthropic API"}; reported N/A without sending anything">not on ${profile.platform === "vertex" ? "Vertex" : "1P"}</span>` : "",
    c.betas?.length ? `<span class="tag beta" title="${esc(c.betas.join(", "))}">beta</span>` : "",
    c.optIn ? `<span class="tag" title="Slow or comparatively expensive; not in the standard set">opt-in</span>` : "",
    c.cost !== "low" && c.cost !== "free" ? `<span class="tag ${c.cost}">${c.cost} cost</span>` : "",
    c.requires?.length ? `<span class="tag" title="Needs advanced settings">needs ${esc(c.requires.join(", "))}</span>` : "",
  ].join("");
  const locked = c.id === "TC-CONN-01";
  return `<label class="case ${na ? "na" : ""}">
    <input type="checkbox" data-case="${c.id}" ${selected.has(c.id) || locked ? "checked" : ""} ${locked ? "disabled title=\"Always runs first\"" : ""}>
    <span class="id">${c.id}</span>
    <span class="title">${esc(c.title)}<span class="purpose">${esc(c.purpose)}</span></span>
    <span class="tags">${tags}</span>
  </label>`;
}

function updateSummary() {
  const chosen = meta.cases.filter((c) => selected.has(c.id) || c.id === "TC-CONN-01");
  const run = chosen.filter(applicable);
  const tiers = { free: 0, low: 0, medium: 0, high: 0 };
  for (const c of run) tiers[c.cost]++;
  const na = chosen.length - run.length;
  $("#selection-summary").textContent =
    `${run.length} case${run.length === 1 ? "" : "s"} will run` +
    (na ? `, ${na} reported N/A for this platform` : "") +
    `. Cost: ${tiers.free + tiers.low} free or low, ${tiers.medium} medium, ${tiers.high} high. Typical full run: well under a dollar on current models.`;
  $("#run").textContent = `Run ${run.length} test case${run.length === 1 ? "" : "s"}`;
  store.set("selection", [...selected]);
}

function select(mode) {
  if (mode === "all") selected = new Set(meta.cases.map((c) => c.id));
  else if (mode === "none") selected = new Set(["TC-CONN-01"]);
  else selected = new Set(meta.defaults);
  renderCases();
}

// ---- running --------------------------------------------------------------

async function startRun() {
  $("#run-error").textContent = "";
  document.querySelectorAll(".field.invalid").forEach((el) => el.classList.remove("invalid"));
  if (needsKey() && !key) {
    $("#run-error").textContent = "Enter the key for this target.";
    $('[data-field="__key"]')?.classList.add("invalid");
    return;
  }
  const res = await fetch("/api/runs", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ profile, key, caseIds: [...selected] }),
  });
  const body = await res.json();
  if (!res.ok) {
    const issues = (body.issues ?? []).map((i) => {
      document.querySelector(`[data-field="${i.path}"]`)?.classList.add("invalid");
      return `${i.path || "target"}: ${i.message}`;
    });
    $("#run-error").textContent = [body.error, ...issues].join(" ");
    return;
  }
  runId = body.id;
  results.clear();
  $("#results").innerHTML = "";
  $("#chips").innerHTML = "";
  $("#findings").innerHTML = "";
  $("#evidence-links").innerHTML = "";
  $("#verdict").hidden = true;
  $("#results-panel").hidden = false;
  $("#results-panel").scrollIntoView({ behavior: "smooth", block: "start" });
  setRunning(true);
  listen(runId);
}

function setRunning(on) {
  $("#run").disabled = on;
  $("#cancel").hidden = !on;
}

function listen(id) {
  source?.close();
  source = new EventSource(`/api/runs/${encodeURIComponent(id)}/events`);
  source.addEventListener("run_started", (e) => {
    const d = JSON.parse(e.data);
    $("#results").innerHTML = d.caseIds.map((cid) => {
      const c = meta.cases.find((x) => x.id === cid);
      return `<tr class="case-row" data-row="${cid}"><td class="mono">${cid}</td><td>${esc(c?.title)}</td><td class="status"><span class="help">queued</span></td><td class="time"></td></tr>`;
    }).join("");
  });
  source.addEventListener("case_started", (e) => {
    const d = JSON.parse(e.data);
    const row = document.querySelector(`[data-row="${d.id}"] .status`);
    if (row) row.innerHTML = `<span class="spin"></span>`;
    progress(d.index, d.total, `Running ${d.id}…`);
  });
  source.addEventListener("case_finished", (e) => {
    const d = JSON.parse(e.data);
    results.set(d.result.id, d.result);
    paintRow(d.result);
    progress(d.index + 1, d.total, `${d.index + 1} of ${d.total} done`);
  });
  source.addEventListener("run_finished", (e) => {
    const d = JSON.parse(e.data);
    finish(d);
  });
  source.addEventListener("run_failed", (e) => {
    const d = JSON.parse(e.data);
    $("#run-error").textContent = `The run stopped: ${d.error}`;
    setRunning(false);
    source.close();
  });
}

function progress(done, total, text) {
  $("#progress-bar").style.width = `${Math.round((done / total) * 100)}%`;
  $("#progress-text").textContent = text;
}

function badge(status) {
  const s = meta.statuses[status];
  return `<span class="badge" style="--c:${s.color}" title="${esc(s.meaning)}">${s.label}</span>`;
}

function paintRow(r) {
  const tr = document.querySelector(`[data-row="${r.id}"]`);
  if (!tr) return;
  tr.querySelector(".status").innerHTML = `${badge(r.status)} <span class="summary">${esc(r.summary)}</span>`;
  tr.querySelector(".time").textContent = r.durationMs ? (r.durationMs < 1000 ? `${r.durationMs} ms` : `${(r.durationMs / 1000).toFixed(1)} s`) : "";
}

function toggleDetail(id) {
  const tr = document.querySelector(`[data-row="${id}"]`);
  const next = tr.nextElementSibling;
  if (next?.classList.contains("detail")) { next.remove(); return; }
  const r = results.get(id);
  if (!r) return;
  const spec = meta.cases.find((c) => c.id === id);
  const checks = r.checks.map((c) => `<li><span class="${c.ok ? "ok" : c.level === "required" ? "no" : "meh"}">${c.ok ? "✓" : c.level === "required" ? "✗" : "!"}</span> ${esc(c.label)}${c.level === "advisory" ? ' <span class="help">(advisory)</span>' : ""} <span class="cdetail">${esc(c.detail ?? "")}</span></li>`).join("");
  const ex = r.exchanges.map((e) => `<li class="ex">#${e.seq} ${esc(e.method)} ${esc(pathOf(e.url))} → <b>${esc(e.status ?? e.error ?? "no response")}</b> · first byte ${e.ttfbMs ?? "–"} ms · total ${e.durationMs ?? "–"} ms${e.label ? ` · ${esc(e.label)}` : ""}</li>`).join("");
  const detail = document.createElement("tr");
  detail.className = "detail";
  detail.innerHTML = `<td colspan="4">
    <p><b>Purpose.</b> ${esc(spec?.purpose)}</p>
    <p><b>Expected.</b> ${esc(spec?.expected)}</p>
    <p class="help">${esc(r.expectation)}</p>
    ${r.hint ? `<div class="hintbox"><b>What to check:</b> ${esc(r.hint)}</div>` : ""}
    ${checks ? `<h4>Checks</h4><ul class="checks">${checks}</ul>` : ""}
    ${r.notes.length ? `<h4>Notes</h4><ul>${r.notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul>` : ""}
    ${ex ? `<h4>HTTP exchanges</h4><ul>${ex}</ul>` : ""}
    <p class="help">Full request and response bodies are in the evidence report.</p>
  </td>`;
  tr.after(detail);
}

function finish(d) {
  setRunning(false);
  source?.close();
  progress(1, 1, `Finished. Evidence written to ${d.evidenceDir}`);
  $("#verdict").hidden = false;
  $("#verdict").textContent = d.summary.verdict;
  $("#chips").innerHTML = Object.entries(d.summary.counts).filter(([, n]) => n).map(([s, n]) => `<span class="chip" style="--c:${meta.statuses[s].color}"><b>${n}</b> ${meta.statuses[s].label}</span>`).join("");
  $("#findings").innerHTML = d.findings.map((f) => `<li class="f-${f.level}"><b>${esc(f.title)}.</b> ${esc(f.detail)}</li>`).join("");
  $("#evidence-links").innerHTML = `<a class="button" href="${d.evidence.html}" target="_blank"><button class="primary">Open evidence report</button></a><a href="${d.evidence.markdown}" target="_blank">Markdown</a><a href="${d.evidence.json}" target="_blank">JSON</a>`;
  loadPast();
}

function pathOf(url) {
  try { const u = new URL(url); return u.pathname + u.search; } catch { return url; }
}

async function loadPast() {
  const runs = await fetch("/api/runs").then((r) => r.json()).catch(() => []);
  $("#past").innerHTML = runs.length
    ? `<table class="past">${runs.slice(0, 20).map((r) => `<tr>
        <td>${esc(new Date(r.startedAt).toLocaleString())}</td>
        <td><b>${esc(r.target)}</b><br><span class="help">${esc(r.model)} · ${esc(r.verdict)}</span></td>
        <td class="links"><a href="/evidence/${encodeURIComponent(r.id)}/report.html" target="_blank">Report</a><a href="/evidence/${encodeURIComponent(r.id)}/report.md" target="_blank">Markdown</a><a href="/evidence/${encodeURIComponent(r.id)}/evidence.json" target="_blank">JSON</a></td>
      </tr>`).join("")}</table>`
    : `<p class="help">No runs yet. Reports are saved in ${esc(meta.evidenceDir)}.</p>`;
}

// ---- boot -----------------------------------------------------------------

async function boot() {
  meta = await fetch("/api/meta").then((r) => r.json());
  const env = meta.environment;
  $("#env").innerHTML = `${esc(env.tool)}<br>@anthropic-ai/sdk ${esc(env.anthropicSdk)} · vertex-sdk ${esc(env.vertexSdk)} · Node ${esc(env.node)}`;
  $("#preset").innerHTML = meta.presets.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join("");

  const savedPreset = store.get("preset", meta.presets[0].id);
  $("#preset").value = savedPreset;
  $("#preset-help").textContent = meta.presets.find((p) => p.id === savedPreset)?.description ?? "";
  profile = store.get("profile", null) ?? structuredClone(meta.presets.find((p) => p.id === savedPreset).profile);
  selected = new Set(store.get("selection", meta.defaults));

  renderForm();
  renderCases();
  loadPast();

  $("#preset").addEventListener("change", (e) => applyPreset(e.target.value));
  for (const form of [$("#target-form"), $("#advanced-form")]) {
    form.addEventListener("input", onFieldChange);
    form.addEventListener("change", onFieldChange);
  }
  $("#cases").addEventListener("change", (e) => {
    const id = e.target.dataset.case;
    const cat = e.target.dataset.catToggle;
    if (id) e.target.checked ? selected.add(id) : selected.delete(id);
    if (cat) for (const c of meta.cases.filter((x) => x.category === cat)) e.target.checked ? selected.add(c.id) : selected.delete(c.id);
    if (cat) renderCases(); else updateSummary();
  });
  $("#cases").addEventListener("toggle", () => {
    store.set("openCats", [...document.querySelectorAll(".cat[open]")].map((d) => d.dataset.cat));
  }, true);
  $("#cases").addEventListener("click", (e) => {
    if (e.target.dataset.catToggle) e.stopPropagation();
  });
  document.querySelectorAll("[data-select]").forEach((b) => b.addEventListener("click", () => select(b.dataset.select)));
  $("#run").addEventListener("click", startRun);
  $("#cancel").addEventListener("click", async () => {
    if (runId) await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" });
    $("#progress-text").textContent = "Cancelling after the current case…";
  });
  $("#results").addEventListener("click", (e) => {
    const row = e.target.closest("tr.case-row");
    if (row) toggleDetail(row.dataset.row);
  });
}

boot().catch((err) => {
  document.body.insertAdjacentHTML("afterbegin", `<p class="error" style="padding:16px">Could not load: ${esc(err.message)}. Is the server running?</p>`);
});
