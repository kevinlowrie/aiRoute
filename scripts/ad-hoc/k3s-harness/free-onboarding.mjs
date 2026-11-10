// Free onboarding: what a first-run desktop setup would do. Lists the providers
// that need no signup or API key, then (with --apply) enables the ones you pick
// and builds a priority combo from them.
//
// Run (list only):  node scripts/ad-hoc/k3s-harness/free-onboarding.mjs
// Run (enable):     node scripts/ad-hoc/k3s-harness/free-onboarding.mjs --apply \
//                     --providers uncloseai,aihorde [--combo free-pool] [--strategy priority]
//
// Remember: these are third-party services. Their availability and terms change.
// Re-run free-pool-probe.mjs to see what really answers today.

import { parseArgs } from "node:util";
import { createChecks, createCombo, omniOk, preflight, printTable, runMain } from "./lib.mjs";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    providers: { type: "string", default: "" },
    combo: { type: "string", default: "free-pool" },
    strategy: { type: "string", default: "priority" },
  },
  strict: true,
});

const requested = values.providers
  .split(",")
  .map((id) => id.trim())
  .filter(Boolean);

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

runMain(async () => {
  await preflight();

  const { providers } = await omniOk("GET", "/api/providers/free-onboarding");
  if (!values.apply) {
    console.log(
      `${providers.length} free providers need no credentials and are not yet enabled:\n`
    );
    printTable(
      providers.map((p) => ({
        id: p.id,
        model: p.defaultModel ?? "-",
        caution: shorten(p.caution, 70),
      })),
      [
        { key: "id", label: "id" },
        { key: "model", label: "default model" },
        { key: "caution", label: "caution (from provider metadata)" },
      ]
    );
    console.log(
      "\nDry run. Enable some with: --apply --providers <id,id> (and optionally --combo <name>)"
    );
    return;
  }

  if (requested.length === 0) throw new Error("--apply needs --providers <id,id,...>");
  const checks = createChecks();
  const candidates = new Map(providers.map((p) => [p.id, p]));
  const missing = requested.filter((id) => !candidates.has(id));
  if (missing.length > 0) {
    console.log(
      `not in the no-credential list (already enabled, or not eligible): ${missing.join(", ")}`
    );
  }

  const body = await omniOk("POST", "/api/providers/free-onboarding", {
    json: { providerIds: requested, confirmed: true },
  });
  printTable(
    body.results.map((r) => ({
      id: r.providerId,
      status: r.status,
      detail: r.connectionId ?? r.reason ?? "",
    })),
    [
      { key: "id", label: "provider" },
      { key: "status", label: "status" },
      { key: "detail", label: "connection / reason" },
    ]
  );

  const usable = body.results.filter((r) => r.status === "created" || r.status === "skipped");
  checks.check(
    "every requested provider is enabled or already was",
    usable.length === requested.length,
    `${usable.length}/${requested.length}`
  );

  if (values.combo && usable.length > 0) {
    const models = usable
      .map((r) => candidates.get(r.providerId))
      .filter((p) => p && p.defaultModel)
      .map((p) => `${p.id}/${p.defaultModel}`);
    const leftOut = usable
      .filter((r) => !candidates.get(r.providerId)?.defaultModel)
      .map((r) => r.providerId);
    if (leftOut.length > 0) {
      console.log(
        `left out of the combo (already enabled, so its default model was not listed): ${leftOut.join(", ")}`
      );
    }
    if (models.length > 0) {
      const combo = await createCombo({
        name: values.combo,
        strategy: values.strategy,
        models,
      });
      console.log(`\ncreated combo ${combo.name} (${models.length} models, ${values.strategy})`);
      console.log(
        `try it: node scripts/ad-hoc/k3s-harness/free-pool-probe.mjs --model ${combo.name}`
      );
    }
  }
  checks.finish();
});
