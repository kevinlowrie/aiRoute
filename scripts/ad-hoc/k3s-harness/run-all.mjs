// Runs the drills in order and reports one pass/fail line per drill.
//   1. smoke              (adds --model from HARNESS_SMOKE_MODEL, if set)
//   2. fallback-drill     (needs the mock upstream)
//   3. tenant-isolation   (needs the mock upstream)
//   4. free-pool-probe    (only if HARNESS_PROBE_MODEL is set; sends 10 requests)
// Each drill cleans up after itself. Run cleanup.mjs --apply afterwards to sweep leftovers.
//
// Run:  node scripts/ad-hoc/k3s-harness/run-all.mjs

import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

const steps = [
  {
    name: "smoke",
    args: process.env.HARNESS_SMOKE_MODEL ? ["--model", process.env.HARNESS_SMOKE_MODEL] : [],
  },
  { name: "fallback-drill", args: [] },
  { name: "tenant-isolation", args: [] },
];
if (process.env.HARNESS_PROBE_MODEL) {
  steps.push({ name: "free-pool-probe", args: ["--requests", "10", "--concurrency", "3"] });
}

const failed = [];
for (const step of steps) {
  console.log(`\n=== ${step.name} ===`);
  const result = spawnSync(process.execPath, [path.join(here, `${step.name}.mjs`), ...step.args], {
    stdio: "inherit",
    env: process.env,
  });
  const ok = result.status === 0;
  console.log(`=== ${step.name}: ${ok ? "OK" : `FAILED (exit ${result.status})`} ===`);
  if (!ok) failed.push(step.name);
}

console.log(failed.length === 0 ? "\nall drills passed" : `\nfailed: ${failed.join(", ")}`);
process.exitCode = failed.length === 0 ? 0 : 1;
