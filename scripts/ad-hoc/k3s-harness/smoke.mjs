// Smoke test: is the OmniRoute you pointed at alive, can the admin log in, and
// does a fresh inference key work? Creates one harness key and deletes it.
//
// Run:  node scripts/ad-hoc/k3s-harness/smoke.mjs [--model <combo-or-model>] [--keep]

import { parseArgs } from "node:util";
import {
  chat,
  config,
  createChecks,
  createKey,
  deleteKey,
  omni,
  preflight,
  runMain,
  stamp,
} from "./lib.mjs";

const { values } = parseArgs({
  options: {
    model: { type: "string" },
    keep: { type: "boolean", default: false },
  },
  strict: true,
});

runMain(async () => {
  await preflight();
  const checks = createChecks();

  const health = await omni("GET", "/api/monitoring/health");
  checks.check("management login works", health.ok, health.ok ? "" : `HTTP ${health.status}`);
  if (health.ok) {
    const s = health.body?.providerSummary ?? {};
    console.log(
      `version ${health.body?.version ?? "?"}, status ${health.body?.status ?? "?"}; ` +
        `providers: catalog=${s.catalogCount ?? "?"} configured=${s.configuredCount ?? "?"} active=${s.activeCount ?? "?"}`
    );
  }

  const key = await createKey(`smoke-${stamp()}`);
  checks.check("created a harness inference key", Boolean(key.key), key.name);

  const models = await fetch(`${config.omniUrl}/v1/models`, {
    headers: { authorization: `Bearer ${key.key}` },
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const modelBody = await models.json().catch(() => null);
  const count = Array.isArray(modelBody?.data) ? modelBody.data.length : 0;
  checks.check(
    "/v1/models answers with the key",
    models.ok,
    `HTTP ${models.status}, ${count} models`
  );

  if (values.model) {
    const result = await chat({ key: key.key, model: values.model, maxTokens: 16 });
    const ok = result.status >= 200 && result.status < 300;
    checks.check(
      `chat via "${values.model}" returns 2xx`,
      ok,
      ok
        ? `${Math.round(result.latencyMs)} ms, provider ${result.decision?.provider ?? "unknown"}`
        : `HTTP ${result.status} ${result.errorCode}: ${result.errorMessage}`
    );
    if (ok && result.content) console.log(`reply: ${result.content.slice(0, 160)}`);
  } else {
    console.log("(skipped chat: pass --model <combo-name> to send one request through it)");
  }

  if (values.keep) {
    console.log(`kept key ${key.name} (id ${key.id}); remove later with cleanup.mjs`);
  } else {
    await deleteKey(key.id);
  }
  checks.finish();
});
