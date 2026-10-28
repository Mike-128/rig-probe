import type { ProbeDef, ProbeSpec } from "./types";
import { connectivity } from "./cases/connectivity";
import { messages } from "./cases/messages";
import { streaming } from "./cases/streaming";
import { multimodal } from "./cases/multimodal";
import { tools } from "./cases/tools";
import { structured } from "./cases/structured";
import { reasoning } from "./cases/reasoning";
import { caching } from "./cases/caching";
import { tokens } from "./cases/tokens";
import { serverTools } from "./cases/server-tools";
import { batches } from "./cases/batches";
import { files } from "./cases/files";
import { sdk } from "./cases/sdk";
import { beta } from "./cases/beta";

/** Every test case, in run order. Connectivity first: later cases depend on it. */
export const ALL_PROBES: ProbeDef[] = [
  ...connectivity,
  ...messages,
  ...streaming,
  ...multimodal,
  ...tools,
  ...structured,
  ...reasoning,
  ...caching,
  ...tokens,
  ...serverTools,
  ...batches,
  ...files,
  ...sdk,
  ...beta,
];

/** Always runs first; if it does not pass, the rest are skipped instead of spending requests on a broken path. */
export const PREREQUISITE_ID = "TC-CONN-01";
/** Loads the live capability report that refines later expectations. */
export const MODEL_INFO_ID = "TC-CONN-03";

const seen = new Set<string>();
for (const p of ALL_PROBES) {
  if (seen.has(p.id)) throw new Error(`Duplicate test case ID ${p.id}`);
  seen.add(p.id);
}

export function specOf(p: ProbeDef): ProbeSpec {
  const { run: _run, ...spec } = p;
  return spec;
}

export const ALL_SPECS: ProbeSpec[] = ALL_PROBES.map(specOf);

/** The standard selection: everything except slow or comparatively expensive opt-in cases. */
export function defaultCaseIds(): string[] {
  return ALL_PROBES.filter((p) => !p.optIn).map((p) => p.id);
}

export function findProbe(id: string): ProbeDef | undefined {
  return ALL_PROBES.find((p) => p.id === id);
}
