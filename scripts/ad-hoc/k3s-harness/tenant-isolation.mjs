// Tenant isolation drill: two tenants share one gateway.
//   tenant A: may call combo A only, capped at 3 requests per 60 s
//   tenant B: may call combo B only, no cap
// Checks: A is throttled after its cap, B is unaffected by A's cap, each key is
// refused on the other tenant's combo, and an inference key cannot reach the
// management API.
//
// Run:  node scripts/ad-hoc/k3s-harness/tenant-isolation.mjs [--cap 3] [--keep]
// Needs the mock upstream (see README.md).

import { parseArgs } from "node:util";
import {
  MOCK_MODEL,
  chat,
  config,
  createChecks,
  createCombo,
  createConnection,
  createKey,
  createNode,
  deleteCombo,
  deleteConnection,
  deleteKey,
  deleteNode,
  mockBaseUrl,
  mockControl,
  patchKey,
  preflight,
  runMain,
  tagged,
} from "./lib.mjs";

const { values } = parseArgs({
  options: {
    cap: { type: "string", default: "3" },
    keep: { type: "boolean", default: false },
  },
  strict: true,
});

const CAP = Number(values.cap);
const WINDOW_SECONDS = 60;
const MOCK_NAME = tagged("tenant-mock");

const isOk = (r) => r.status >= 200 && r.status < 300;

runMain(async () => {
  if (!Number.isInteger(CAP) || CAP < 1) throw new Error("--cap must be >= 1");
  await preflight({ needMock: true });
  const checks = createChecks();

  const created = {
    node: null,
    connection: null,
    comboA: null,
    comboB: null,
    keyA: null,
    keyB: null,
  };

  try {
    await mockControl(MOCK_NAME, { reset: true, mode: "ok", latencyMs: 10 });

    created.node = await createNode({
      name: "tenant-mock",
      prefix: "tenant-mock",
      baseUrl: mockBaseUrl(MOCK_NAME),
    });
    created.connection = await createConnection({
      provider: created.node.id,
      apiKey: "harness-mock-key",
      name: "tenant-mock-conn",
    });
    const model = `${created.node.prefix}/${MOCK_MODEL}`;
    created.comboA = await createCombo({ name: "tenant-combo-a", models: [model] });
    created.comboB = await createCombo({ name: "tenant-combo-b", models: [model] });

    created.keyA = await createKey("tenant-a", {
      modelAccessMode: "restricted",
      allowedCombos: [created.comboA.name],
    });
    created.keyB = await createKey("tenant-b", {
      modelAccessMode: "restricted",
      allowedCombos: [created.comboB.name],
    });
    await patchKey(created.keyA.id, {
      rateLimits: [{ limit: CAP, window: WINDOW_SECONDS }],
    });

    // Tenant A exceeds its cap on purpose.
    const aResults = [];
    for (let i = 0; i < CAP + 2; i += 1) {
      aResults.push(
        await chat({ key: created.keyA.key, model: created.comboA.name, maxTokens: 8 })
      );
    }
    const aAllowed = aResults.slice(0, CAP);
    const aOverCap = aResults.slice(CAP);
    checks.check(
      `tenant A: first ${CAP} requests succeed`,
      aAllowed.every(isOk),
      aAllowed.map((r) => r.status).join(",")
    );
    checks.check(
      `tenant A: request ${CAP + 1}+ rejected with rate_limit_exceeded`,
      aOverCap.every((r) => r.status === 429 && r.errorCode === "rate_limit_exceeded"),
      aOverCap.map((r) => `${r.status}/${r.errorCode}`).join(",")
    );

    // Tenant B runs after A is already throttled. It must not inherit A's cap.
    const bResults = [];
    for (let i = 0; i < 2; i += 1) {
      bResults.push(
        await chat({ key: created.keyB.key, model: created.comboB.name, maxTokens: 8 })
      );
    }
    checks.check(
      "tenant B unaffected by tenant A's cap",
      bResults.every(isOk),
      bResults.map((r) => r.status).join(",")
    );

    const aOnB = await chat({ key: created.keyA.key, model: created.comboB.name, maxTokens: 8 });
    checks.check(
      "tenant A refused on tenant B's combo (403)",
      aOnB.status === 403,
      `HTTP ${aOnB.status}`
    );

    const bOnA = await chat({ key: created.keyB.key, model: created.comboA.name, maxTokens: 8 });
    checks.check(
      "tenant B refused on tenant A's combo (403)",
      bOnA.status === 403,
      `HTTP ${bOnA.status}`
    );

    // An inference key must not reach management routes.
    const mgmt = await fetch(`${config.omniUrl}/api/keys`, {
      headers: { authorization: `Bearer ${created.keyA.key}` },
      signal: AbortSignal.timeout(config.timeoutMs),
    });
    checks.check(
      "inference key cannot call management API",
      mgmt.status === 401 || mgmt.status === 403,
      `HTTP ${mgmt.status}`
    );
  } finally {
    if (values.keep) {
      console.log("kept drill resources (remove later with cleanup.mjs)");
    } else {
      if (created.comboA) await deleteCombo(created.comboA.id);
      if (created.comboB) await deleteCombo(created.comboB.id);
      if (created.connection) await deleteConnection(created.connection.id);
      if (created.node) await deleteNode(created.node.id);
      if (created.keyA) await deleteKey(created.keyA.id);
      if (created.keyB) await deleteKey(created.keyB.id);
    }
  }
  checks.finish();
});
