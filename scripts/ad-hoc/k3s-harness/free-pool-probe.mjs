// Free-pool probe: sends N chat requests through a combo or model, a few at a
// time, and reports what actually happened: success rate, which provider served
// each reply, error codes, and latency. Use it to measure free providers, not
// to assume their published limits are true.
//
// Run:  node scripts/ad-hoc/k3s-harness/free-pool-probe.mjs --model harness-free-pool \
//         [--requests 20] [--concurrency 4] [--stream] [--min-success 0.8] [--out <dir>]
// Key:  HARNESS_PROBE_KEY (an inference key). If unset, a temporary key is created.
// Output: a summary on stdout and a JSON report in _artifacts/harness/ (gitignored).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import {
  chat,
  createChecks,
  createKey,
  deleteKey,
  ms,
  percentile,
  preflight,
  printTable,
  redact,
  runMain,
  runPool,
  stamp,
} from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = path.resolve(here, "../../../_artifacts/harness");

const { values } = parseArgs({
  options: {
    model: { type: "string", default: process.env.HARNESS_PROBE_MODEL || "" },
    requests: { type: "string", default: "20" },
    concurrency: { type: "string", default: "4" },
    prompt: { type: "string", default: "Say hi in three words." },
    "max-tokens": { type: "string", default: "32" },
    stream: { type: "boolean", default: false },
    "min-success": { type: "string" },
    out: { type: "string" },
  },
  strict: true,
});

const REQUESTS = Number(values.requests);
const CONCURRENCY = Number(values.concurrency);
const MAX_TOKENS = Number(values["max-tokens"]);
const MIN_SUCCESS = values["min-success"] === undefined ? null : Number(values["min-success"]);

const count = (items, keyOf) => {
  const out = {};
  for (const item of items) {
    const key = keyOf(item);
    out[key] = (out[key] ?? 0) + 1;
  }
  return Object.entries(out).sort((a, b) => b[1] - a[1]);
};

const isOk = (r) => r.status >= 200 && r.status < 300;

runMain(async () => {
  if (!values.model) throw new Error("pass --model <combo-or-model> (or set HARNESS_PROBE_MODEL)");
  if (!Number.isInteger(REQUESTS) || REQUESTS < 1) throw new Error("--requests must be >= 1");
  if (!Number.isInteger(CONCURRENCY) || CONCURRENCY < 1)
    throw new Error("--concurrency must be >= 1");
  if (MIN_SUCCESS !== null && !(MIN_SUCCESS >= 0 && MIN_SUCCESS <= 1)) {
    throw new Error("--min-success must be between 0 and 1");
  }
  await preflight();
  const checks = createChecks();

  let temporaryKey = null;
  let key = process.env.HARNESS_PROBE_KEY || "";
  if (!key) {
    temporaryKey = await createKey(`probe-${stamp()}`);
    key = temporaryKey.key;
  }

  const startedAt = new Date().toISOString();
  console.log(
    `probe: model=${values.model} requests=${REQUESTS} concurrency=${CONCURRENCY} stream=${values.stream}`
  );

  let records;
  try {
    records = await runPool(REQUESTS, CONCURRENCY, async (index) => {
      const r = await chat({
        key,
        model: values.model,
        prompt: values.prompt,
        maxTokens: MAX_TOKENS,
        stream: values.stream,
      });
      return {
        index: index + 1,
        status: r.status,
        latencyMs: Math.round(r.latencyMs),
        ttfbMs: r.ttfbMs === null ? null : Math.round(r.ttfbMs),
        servedBy: r.decision?.provider ?? r.mockTag ?? null,
        decisionHeader: r.decision !== null,
        strategy: r.decision?.strategy ?? null,
        errorCode: r.errorCode,
        errorMessage: r.errorMessage,
        diagnostics: r.diagnostics ? redact(JSON.stringify(r.diagnostics)).slice(0, 400) : null,
        replyPreview: r.content ? redact(r.content).slice(0, 120) : null,
      };
    });
  } finally {
    if (temporaryKey) await deleteKey(temporaryKey.id);
  }

  const ok = records.filter(isOk);
  const failed = records.filter((r) => !isOk(r));
  const successRate = ok.length / records.length;
  const latencies = ok.map((r) => r.latencyMs);
  const ttfbs = ok.map((r) => r.ttfbMs).filter((v) => v !== null);

  console.log(`\nsuccess ${ok.length}/${records.length} (${Math.round(successRate * 100)}%)`);
  // Only successful replies are expected to carry the routing header.
  const missingHeader = ok.filter((r) => !r.decisionHeader).length;
  if (missingHeader > 0) {
    console.log(
      `note: ${missingHeader} repl${missingHeader === 1 ? "y" : "ies"} had no X-OmniRoute-Decision header; "served by" falls back to the reply text`
    );
  }
  console.log(
    "status: " +
      count(records, (r) => String(r.status))
        .map(([s, n]) => `${s} x${n}`)
        .join(", ")
  );

  if (ok.length > 0) {
    console.log("\nserved by (successful replies):");
    printTable(
      count(ok, (r) => r.servedBy ?? "unknown").map(([provider, n]) => ({ provider, n })),
      [
        { key: "provider", label: "provider" },
        { key: "n", label: "replies" },
      ]
    );
  }

  if (failed.length > 0) {
    console.log("\nerror codes:");
    for (const [code, n] of count(failed, (r) => r.errorCode ?? "unknown")) {
      console.log(`  ${code} x${n}`);
    }
    const samples = [...new Set(failed.map((r) => `[${r.status}] ${r.errorMessage ?? ""}`))].slice(
      0,
      3
    );
    console.log("\nsample errors:");
    for (const sample of samples) console.log(`  - ${sample}`);
  }

  console.log(
    `\nlatency (successful): p50 ${ms(percentile(latencies, 50))}, p95 ${ms(percentile(latencies, 95))}, max ${ms(latencies.length ? Math.max(...latencies) : null)}`
  );
  if (values.stream && ttfbs.length > 0) {
    console.log(
      `time to first byte: p50 ${ms(percentile(ttfbs, 50))}, p95 ${ms(percentile(ttfbs, 95))}`
    );
  }

  const outDir = values.out ? path.resolve(values.out) : DEFAULT_OUT_DIR;
  fs.mkdirSync(outDir, { recursive: true });
  const reportPath = path.join(outDir, `free-pool-probe-${stamp()}.json`);
  const report = {
    startedAt,
    model: values.model,
    requests: REQUESTS,
    concurrency: CONCURRENCY,
    stream: values.stream,
    summary: {
      success: ok.length,
      total: records.length,
      successRate,
      status: Object.fromEntries(count(records, (r) => String(r.status))),
      servedBy: Object.fromEntries(count(ok, (r) => r.servedBy ?? "unknown")),
      errorCodes: Object.fromEntries(count(failed, (r) => r.errorCode ?? "unknown")),
      latencyMs: { p50: percentile(latencies, 50), p95: percentile(latencies, 95) },
    },
    records,
  };
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nreport: ${reportPath}`);

  if (MIN_SUCCESS !== null) {
    checks.check(
      `success rate >= ${Math.round(MIN_SUCCESS * 100)}%`,
      successRate >= MIN_SUCCESS,
      `${Math.round(successRate * 100)}%`
    );
    checks.finish();
  }
});
