// Cleanup: removes what the harness created. Anything whose name starts with
// HARNESS_TAG ("harness-") is in scope. Provider connections can also be picked
// by provider id, for example the ones free-onboarding.mjs enabled.
//
// Dry run by default. Nothing is deleted without --apply.
//
// Run:  node scripts/ad-hoc/k3s-harness/cleanup.mjs
//       node scripts/ad-hoc/k3s-harness/cleanup.mjs --providers uncloseai,duckduckgo-web --apply

import { parseArgs } from "node:util";
import {
  config,
  deleteCombo,
  deleteConnection,
  deleteKey,
  deleteNode,
  listAll,
  preflight,
  printTable,
  runMain,
} from "./lib.mjs";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    providers: { type: "string", default: "" },
  },
  strict: true,
});

const providerIds = new Set(
  values.providers
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean)
);
const mine = (name) => typeof name === "string" && name.startsWith(config.tag);

runMain(async () => {
  await preflight();

  const [combos, connections, nodes, keys] = await Promise.all([
    listAll("/api/combos", "combos"),
    listAll("/api/providers", "connections"),
    listAll("/api/provider-nodes", "nodes"),
    listAll("/api/keys", "keys"),
  ]);

  // Order matters: combos and connections go before the nodes they point at.
  const plan = [
    ...combos
      .filter((c) => mine(c.name))
      .map((c) => ({ kind: "combo", id: c.id, name: c.name, del: deleteCombo })),
    ...connections
      .filter((c) => mine(c.name) || providerIds.has(c.provider))
      .map((c) => ({
        kind: "connection",
        id: c.id,
        name: c.name || c.provider,
        del: deleteConnection,
      })),
    ...nodes
      .filter((n) => mine(n.name) || mine(n.prefix))
      .map((n) => ({ kind: "node", id: n.id, name: n.name, del: deleteNode })),
    ...keys
      .filter((k) => mine(k.name))
      .map((k) => ({ kind: "key", id: k.id, name: k.name, del: deleteKey })),
  ];

  if (plan.length === 0) {
    console.log("nothing to clean up");
    return;
  }

  printTable(
    plan.map((item) => ({ kind: item.kind, name: item.name, id: item.id })),
    [
      { key: "kind", label: "kind" },
      { key: "name", label: "name" },
      { key: "id", label: "id" },
    ]
  );

  if (!values.apply) {
    console.log(`\ndry run: ${plan.length} item(s) listed. Add --apply to delete them.`);
    return;
  }

  let failures = 0;
  for (const item of plan) {
    const result = await item.del(item.id);
    if (result.ok) {
      console.log(`deleted ${item.kind} ${item.name}`);
    } else {
      failures += 1;
      console.log(`FAILED  ${item.kind} ${item.name}: HTTP ${result.status}`);
    }
  }
  if (failures > 0) process.exitCode = 1;
});
