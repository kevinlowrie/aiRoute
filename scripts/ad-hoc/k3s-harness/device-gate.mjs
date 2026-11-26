// Device gate: the Sprint 0 demo check for the homelab milestone. A loopback
// router on one device serves from its free pool, and falls back to the LiteLLM
// edge when the pool is exhausted. The per-device key may use only its own combo.
//
// Pool and edge are both mock upstreams here, so the check is deterministic and
// spends no quota. Point EDGE_URL at the real LiteLLM edge to test it for real.
//
// Run:  node scripts/ad-hoc/k3s-harness/device-gate.mjs [--keep]
// Env:  OMNIROUTE_URL, OMNIROUTE_ADMIN_PASSWORD, HARNESS_MOCK_UPSTREAM_URL,
//       HARNESS_MOCK_CONTROL_URL (see README.md). EDGE_URL overrides the edge base
//       URL, which must be an OpenAI-compatible root ending in /v1.

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
  preflight,
  printTable,
  runMain,
  tagged,
  ms,
} from "./lib.mjs";

const { values } = parseArgs({
  options: {
    keep: { type: "boolean", default: false },
  },
  strict: true,
});

const POOL = { base: "gate-pool" };
const EDGE = { base: "gate-edge" };
const EDGE_URL = process.env.EDGE_URL || "";

runMain(async () => {
  await preflight({ needMock: !EDGE_URL });
  const checks = createChecks();

  const poolMock = tagged(POOL.base);
  const edgeMock = tagged(EDGE.base);
  const created = {
    nodes: [],
    connections: [],
    combo: null,
    otherCombo: null,
    key: null,
    controlKey: null,
  };

  try {
    // The pool starts healthy. The edge always works.
    await mockControl(poolMock, { reset: true, mode: "ok", latencyMs: 20 });
    if (!EDGE_URL) await mockControl(edgeMock, { reset: true, mode: "ok", latencyMs: 20 });

    const poolNode = await createNode({
      name: POOL.base,
      prefix: POOL.base,
      baseUrl: mockBaseUrl(poolMock),
    });
    created.nodes.push(poolNode);
    created.connections.push(
      await createConnection({
        provider: poolNode.id,
        apiKey: "harness-mock-key",
        name: `${POOL.base}-conn`,
      })
    );

    const edgeNode = await createNode({
      name: EDGE.base,
      prefix: EDGE.base,
      baseUrl: EDGE_URL || mockBaseUrl(edgeMock),
    });
    created.nodes.push(edgeNode);
    created.connections.push(
      await createConnection({
        provider: edgeNode.id,
        apiKey: process.env.EDGE_API_KEY || "harness-mock-key",
        name: `${EDGE.base}-conn`,
      })
    );

    created.combo = await createCombo({
      name: "gate-device",
      strategy: "priority",
      models: [`${poolNode.prefix}/${MOCK_MODEL}`, `${edgeNode.prefix}/${MOCK_MODEL}`],
    });

    // The device key may call its own combo and nothing else.
    created.key = await createKey("gate-device-key", {
      modelAccessMode: "restricted",
      allowedCombos: [created.combo.name],
    });

    // A second real combo on the same pool and edge. The device key must be refused on
    // it. An unrestricted control key shows that it is routable, so the 403 means something.
    created.otherCombo = await createCombo({
      name: "gate-other",
      strategy: "priority",
      models: [`${poolNode.prefix}/${MOCK_MODEL}`, `${edgeNode.prefix}/${MOCK_MODEL}`],
    });
    created.controlKey = await createKey("gate-control-key");

    // Step 1: the pool is healthy, so the device is served from the pool.
    const healthy = [];
    for (let i = 0; i < 3; i += 1) {
      healthy.push(
        await chat({
          key: created.key.key,
          model: created.combo.name,
          prompt: `pool ${i + 1}`,
          maxTokens: 8,
        })
      );
    }
    checks.check(
      "pool healthy: all requests return 2xx",
      healthy.every((r) => r.status >= 200 && r.status < 300),
      healthy.map((r) => r.status).join(",")
    );
    checks.check(
      "pool healthy: the pool serves the replies",
      healthy.every((r) => r.mockTag === poolMock),
      healthy.map((r) => r.mockTag ?? "-").join(",")
    );

    const control = await chat({
      key: created.controlKey.key,
      model: created.otherCombo.name,
      prompt: "control",
      maxTokens: 8,
    });
    checks.check(
      "control key reaches the other combo (routable)",
      control.status >= 200 && control.status < 300 && control.mockTag === poolMock,
      `HTTP ${control.status}, served by ${control.mockTag ?? "-"}`
    );

    // Step 2: exhaust the pool. Every pool call now fails, and the edge takes over.
    await mockControl(poolMock, { mode: "fail", status: 503 });
    const exhausted = [];
    for (let i = 0; i < 3; i += 1) {
      exhausted.push(
        await chat({
          key: created.key.key,
          model: created.combo.name,
          prompt: `exhausted ${i + 1}`,
          maxTokens: 8,
        })
      );
    }
    checks.check(
      "pool exhausted: the device still gets 2xx",
      exhausted.every((r) => r.status >= 200 && r.status < 300),
      exhausted.map((r) => r.status).join(",")
    );
    // Mock mode: the edge's reply carries its name. Real-edge mode: a real reply has no
    // mock tag, so check the provider in the routing decision. That field holds the node's
    // alias (usually its prefix) or, with no alias, its id, so accept either.
    const edgeNames = [edgeNode.prefix, edgeNode.id];
    const servedByEdge = (r) =>
      EDGE_URL ? edgeNames.includes(r.decision?.provider) : r.mockTag === edgeMock;
    checks.check(
      "pool exhausted: the edge serves the replies",
      exhausted.every(servedByEdge),
      exhausted.map((r) => r.decision?.provider ?? r.mockTag ?? "-").join(",")
    );

    // Step 3: the device key is refused on a combo that exists, not on a typo.
    const other = await chat({
      key: created.key.key,
      model: created.otherCombo.name,
      maxTokens: 8,
    });
    checks.check(
      "device key refused on another valid combo (403)",
      other.status === 403,
      `HTTP ${other.status}`
    );

    const poolStats = await mockState(poolMock);
    const edgeStats = await mockState(edgeMock);
    printTable(
      [
        { who: "pool", served: poolStats?.served ?? "-", failed: poolStats?.failed ?? "-" },
        { who: "edge", served: edgeStats?.served ?? "-", failed: edgeStats?.failed ?? "-" },
      ],
      [
        { key: "who", label: "upstream" },
        { key: "served", label: "served" },
        { key: "failed", label: "failed" },
      ]
    );
    console.log(`healthy-step latency p50 ~ ${ms(healthy[0]?.latencyMs)}`);
  } finally {
    if (values.keep) {
      console.log("kept gate resources (remove later with cleanup.mjs)");
    } else {
      if (created.combo) await deleteCombo(created.combo.id);
      if (created.otherCombo) await deleteCombo(created.otherCombo.id);
      for (const connection of created.connections) await deleteConnection(connection.id);
      for (const node of created.nodes) await deleteNode(node.id);
      if (created.key) await deleteKey(created.key.id);
      if (created.controlKey) await deleteKey(created.controlKey.id);
      await mockControl(poolMock, { mode: "ok" }).catch(() => {});
    }
  }
  checks.finish();
});
