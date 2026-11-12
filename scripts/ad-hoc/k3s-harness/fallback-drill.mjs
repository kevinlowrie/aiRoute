// Fallback drill: a priority combo lists a failing provider first and a healthy
// one second. The client should still get 2xx on every request, the healthy
// provider should serve them, and the failing one should stop getting traffic.
//
// Run:  node scripts/ad-hoc/k3s-harness/fallback-drill.mjs [--requests 10] [--max-bad-hits 3] [--keep]
// Needs the mock upstream (see README.md).

import { parseArgs } from "node:util";
import {
  MOCK_MODEL,
  chat,
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
  mockState,
  ms,
  preflight,
  printTable,
  runMain,
  tagged,
} from "./lib.mjs";

const { values } = parseArgs({
  options: {
    requests: { type: "string", default: "10" },
    "max-bad-hits": { type: "string", default: "3" },
    keep: { type: "boolean", default: false },
  },
  strict: true,
});

const REQUESTS = Number(values.requests);
const MAX_BAD_HITS = Number(values["max-bad-hits"]);

// Base names. Helpers add the harness tag, and the mock uses the tagged name as
// its upstream name, so the tagged name is what ends up in the URL path.
const BAD = { base: "drill-bad", mode: "fail" };
const GOOD = { base: "drill-good", mode: "ok" };

runMain(async () => {
  if (!Number.isInteger(REQUESTS) || REQUESTS < 1) throw new Error("--requests must be >= 1");
  if (!Number.isInteger(MAX_BAD_HITS) || MAX_BAD_HITS < 0) {
    throw new Error("--max-bad-hits must be >= 0");
  }
  await preflight({ needMock: true });
  const checks = createChecks();

  const badMock = tagged(BAD.base);
  const goodMock = tagged(GOOD.base);
  const created = { nodes: [], connections: [], combo: null, key: null };

  try {
    await mockControl(badMock, { reset: true, mode: "fail", status: 503, latencyMs: 20 });
    await mockControl(goodMock, { reset: true, mode: "ok", latencyMs: 20 });

    for (const side of [BAD, GOOD]) {
      const node = await createNode({
        name: side.base,
        prefix: side.base,
        baseUrl: mockBaseUrl(tagged(side.base)),
      });
      created.nodes.push(node);
      created.connections.push(
        await createConnection({
          provider: node.id,
          apiKey: "harness-mock-key",
          name: `${side.base}-conn`,
        })
      );
    }

    const [badNode, goodNode] = created.nodes;
    created.combo = await createCombo({
      name: "drill-fallback",
      strategy: "priority",
      models: [`${badNode.prefix}/${MOCK_MODEL}`, `${goodNode.prefix}/${MOCK_MODEL}`],
    });
    created.key = await createKey("drill-key");

    const results = [];
    for (let i = 0; i < REQUESTS; i += 1) {
      results.push(
        await chat({
          key: created.key.key,
          model: created.combo.name,
          prompt: `drill request ${i + 1}`,
          maxTokens: 16,
        })
      );
    }

    printTable(
      results.map((r, i) => ({
        n: i + 1,
        status: r.status,
        served: r.mockTag ?? "-",
        latency: ms(r.latencyMs),
      })),
      [
        { key: "n", label: "#" },
        { key: "status", label: "HTTP" },
        { key: "served", label: "served by" },
        { key: "latency", label: "latency" },
      ]
    );

    const succeeded = results.filter((r) => r.status >= 200 && r.status < 300);
    checks.check(
      `client saw 2xx on all ${REQUESTS} requests`,
      succeeded.length === REQUESTS,
      `${succeeded.length}/${REQUESTS} succeeded`
    );

    const servedByGood = results.filter((r) => r.mockTag === goodMock).length;
    checks.check(
      "healthy provider served every successful reply",
      succeeded.length > 0 && servedByGood === succeeded.length,
      `${servedByGood} served by ${goodMock}`
    );

    const badHits = (await mockState(badMock))?.failed ?? null;
    checks.check(
      `failing provider stopped receiving traffic (<= ${MAX_BAD_HITS} hits)`,
      badHits !== null && badHits <= MAX_BAD_HITS,
      `failing upstream saw ${badHits ?? "unknown"} of ${REQUESTS} requests`
    );

    const goodServed = (await mockState(goodMock))?.served ?? 0;
    checks.check(
      "healthy upstream carried the load",
      goodServed >= REQUESTS - MAX_BAD_HITS,
      `healthy upstream served ${goodServed}`
    );
  } finally {
    if (values.keep) {
      console.log("kept drill resources (remove later with cleanup.mjs)");
    } else {
      if (created.combo) await deleteCombo(created.combo.id);
      for (const connection of created.connections) await deleteConnection(connection.id);
      for (const node of created.nodes) await deleteNode(node.id);
      if (created.key) await deleteKey(created.key.id);
      await mockControl(badMock, { mode: "ok" }).catch(() => {});
    }
  }
  checks.finish();
});
