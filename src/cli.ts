import { Command } from "commander";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { renderCatalog } from "./evidence/catalog";
import { STATUS_INFO, fmtCost } from "./evidence/common";
import { writeEvidence } from "./evidence/write";
import { type Profile, PRESETS, ProfileSchema } from "./profile";
import { ALL_SPECS, defaultCaseIds } from "./probes/registry";
import { runProbes } from "./probes/runner";

const program = new Command().name("rig-probe").description("Probe which Anthropic SDK features work through a gateway and model, with documented evidence.");

program
  .command("run")
  .description("Run test cases against a target and write an evidence pack")
  .option("--preset <id>", `start from a preset: ${PRESETS.map((p) => p.id).join(", ")}`)
  .option("--profile <file>", "target profile as JSON (same fields as the web form)")
  .option("--name <name>", "label for the target in the report")
  .option("--base-url <url>", "base URL the SDK sends to")
  .option("--model <id>", "model ID")
  .option("--platform <platform>", "upstream platform: anthropic | vertex")
  .option("--client <client>", "SDK client: anthropic | vertex")
  .option("--auth <mode>", "credential placement: bearer | x-api-key | header | google-adc | none")
  .option("--header-name <name>", "header for --auth header, e.g. Ocp-Apim-Subscription-Key")
  .option("--header-prefix <prefix>", "text before the key in that header")
  .option("--project <id>", "GCP project ID (Vertex client)")
  .option("--region <region>", "GCP region (Vertex client)")
  .option("--api-version <version>", "override the anthropic-version header")
  .option("--key-env <VAR>", "environment variable holding the key (keys are never taken as flag values)", "RIG_PROBE_KEY")
  .option("--cases <ids>", "comma-separated case IDs to run")
  .option("--categories <ids>", "comma-separated categories to run")
  .option("--all", "include opt-in cases (slow or comparatively expensive)")
  .action(async (o) => {
    let base: Partial<Profile> = {};
    if (o.preset) {
      const preset = PRESETS.find((p) => p.id === o.preset);
      if (!preset) throw new Error(`Unknown preset ${o.preset}. Choose from: ${PRESETS.map((p) => p.id).join(", ")}`);
      base = structuredClone(preset.profile);
    }
    if (o.profile) base = { ...base, ...JSON.parse(readFileSync(o.profile, "utf8")) };
    const merged = {
      ...base,
      ...(o.name && { name: o.name }),
      ...(o.baseUrl && { baseUrl: o.baseUrl }),
      ...(o.model && { model: o.model }),
      ...(o.platform && { platform: o.platform }),
      ...(o.client && { client: o.client }),
      ...(o.apiVersion && { apiVersion: o.apiVersion }),
      auth: { ...(base.auth ?? { mode: "bearer" }), ...(o.auth && { mode: o.auth }), ...(o.headerName && { headerName: o.headerName }), ...(o.headerPrefix && { prefix: o.headerPrefix }) },
      ...((o.project || o.region) && { vertex: { projectId: o.project ?? base.vertex?.projectId ?? "", region: o.region ?? base.vertex?.region ?? "global" } }),
    };
    const parsed = ProfileSchema.safeParse({ name: "CLI target", ...merged });
    if (!parsed.success) {
      console.error("Target settings are incomplete:");
      for (const i of parsed.error.issues) console.error(`  ${i.path.join(".") || "(target)"}: ${i.message}`);
      process.exit(2);
    }
    const profile = parsed.data;
    const key = process.env[o.keyEnv] ?? "";
    if (!key && !["google-adc", "none"].includes(profile.auth.mode)) {
      console.error(`Set the key in the ${o.keyEnv} environment variable (or choose another with --key-env).`);
      process.exit(2);
    }

    let caseIds = o.all ? ALL_SPECS.map((s) => s.id) : defaultCaseIds();
    if (o.categories) {
      const cats = new Set(String(o.categories).split(",").map((s) => s.trim()));
      caseIds = ALL_SPECS.filter((s) => cats.has(s.category) && (o.all || !s.optIn)).map((s) => s.id);
    }
    if (o.cases) caseIds = String(o.cases).split(",").map((s) => s.trim().toUpperCase());

    console.log(`Rig Probe → ${profile.name} (${profile.model} via ${profile.baseUrl})\n`);
    const record = await runProbes({
      profile,
      secret: key,
      caseIds,
      onEvent: (e) => {
        if (e.type === "case_finished") {
          const s = STATUS_INFO[e.result.status];
          const spec = ALL_SPECS.find((x) => x.id === e.result.id);
          console.log(`${String(e.index + 1).padStart(3)}/${e.total}  ${s.label.padEnd(11)} ${e.result.id.padEnd(14)} ${spec?.title ?? ""}`);
          if (!["pass", "n/a", "skipped"].includes(e.result.status)) console.log(`${" ".repeat(18)}${e.result.summary}`);
        }
      },
    });
    const paths = writeEvidence(record, key);
    console.log(`\n${record.summary.verdict}  Estimated cost ${fmtCost(record.summary.costUsd)}.`);
    for (const f of record.findings) console.log(`  [${f.level}] ${f.title}`);
    console.log(`\nEvidence:\n  ${paths.html}\n  ${paths.markdown}\n  ${paths.json}`);
    const c = record.summary.counts;
    process.exit(c.fail + c.blocked + c.error > 0 ? 1 : 0);
  });

program
  .command("catalog")
  .description("Write the test case catalog generated from the case definitions")
  .option("--out <file>", "output path", "docs/TEST-CASES.md")
  .action((o) => {
    mkdirSync(path.dirname(o.out), { recursive: true });
    writeFileSync(o.out, renderCatalog(), "utf8");
    console.log(`Wrote ${o.out} (${ALL_SPECS.length} test cases).`);
  });

program
  .command("cases")
  .description("List test cases")
  .action(() => {
    for (const s of ALL_SPECS) console.log(`${s.id.padEnd(14)} ${s.optIn ? "(opt-in) " : ""}${s.title}`);
  });

program
  .command("presets")
  .description("List target presets")
  .action(() => {
    for (const p of PRESETS) console.log(`${p.id.padEnd(22)} ${p.label}\n${" ".repeat(23)}${p.description}\n`);
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
