// Fake OpenAI-compatible upstream for the k3s harness.
//
// One process serves many fake providers, each addressed by a path prefix, so a
// drill can point a "bad" provider and a "good" provider at the same pod:
//
//   OmniRoute provider baseUrl : http://<mock-host>:9100/u/<name>/v1
//   Harness control (per name) : POST http://<mock-host>:9100/__control/<name>
//
// Per-upstream modes:
//   ok     - serve every request
//   fail   - always answer with `status` (default 503)
//   flaky  - fail with probability `errorRate`
// Every call also waits `latencyMs` first.
//
// Run:  node scripts/ad-hoc/k3s-harness/mock-upstream.mjs
// Env:  MOCK_PORT (9100)  MOCK_HOST (127.0.0.1)  MOCK_MODEL_ID (harness-mock-model)
//       MOCK_LATENCY_MS (50)  MOCK_API_KEY (unset = accept any Bearer token)
//
// Lab use only. /__control is unauthenticated, so keep MOCK_HOST on loopback
// locally, and expose it in-cluster only through the ClusterIP Service.

import http from "node:http";

const PORT = Number(process.env.MOCK_PORT || 9100);
const HOST = process.env.MOCK_HOST || "127.0.0.1";
const MODEL_ID = process.env.MOCK_MODEL_ID || "harness-mock-model";
const REQUIRED_KEY = process.env.MOCK_API_KEY || "";
const DEFAULT_LATENCY_MS = Number(process.env.MOCK_LATENCY_MS || 50);
const MODES = new Set(["ok", "fail", "flaky"]);
const MAX_BODY_BYTES = 1024 * 1024;
const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,62}$/;

const upstreams = new Map();

function newState() {
  return {
    mode: "ok",
    status: 503,
    latencyMs: DEFAULT_LATENCY_MS,
    errorRate: 0.5,
    served: 0,
    failed: 0,
  };
}

function stateFor(name) {
  if (!upstreams.has(name)) upstreams.set(name, newState());
  return upstreams.get(name);
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    ...headers,
  });
  res.end(payload);
}

function openAiError(res, status, message, code, name) {
  sendJson(
    res,
    status,
    { error: { message, type: "server_error", code } },
    { "x-harness-upstream": name }
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJsonBody(text) {
  if (!text) return {};
  return JSON.parse(text);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shouldFail(state) {
  if (state.mode === "fail") return true;
  if (state.mode === "flaky") return Math.random() < state.errorRate;
  return false;
}

function authorized(req) {
  if (!REQUIRED_KEY) return true;
  return req.headers.authorization === `Bearer ${REQUIRED_KEY}`;
}

async function handleChat(req, res, name, state) {
  if (!authorized(req)) {
    return openAiError(res, 401, "mock: bad or missing API key", "invalid_api_key", name);
  }
  let body;
  try {
    body = parseJsonBody(await readBody(req));
  } catch {
    return openAiError(res, 400, "mock: request body is not JSON", "invalid_json", name);
  }

  await sleep(state.latencyMs);

  if (shouldFail(state)) {
    state.failed += 1;
    return openAiError(
      res,
      state.status,
      `mock upstream "${name}" failing on purpose`,
      "harness_mock_failure",
      name
    );
  }

  state.served += 1;
  const lastUser = [...(Array.isArray(body.messages) ? body.messages : [])]
    .reverse()
    .find((m) => m && m.role === "user");
  const prompt = typeof lastUser?.content === "string" ? lastUser.content.slice(0, 200) : "";
  const text = `[${name}] ${prompt || "ok"}`;
  const model = typeof body.model === "string" ? body.model : MODEL_ID;
  const id = `chatcmpl-${name}-${state.served}`;
  const created = Math.floor(Date.now() / 1000);
  const words = text.split(" ");

  if (body.stream === true) {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
      "x-harness-upstream": name,
    });
    for (const word of words) {
      const chunk = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta: { content: `${word} ` }, finish_reason: null }],
      };
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    }
    const last = {
      id,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    };
    res.write(`data: ${JSON.stringify(last)}\n\n`);
    res.write("data: [DONE]\n\n");
    return res.end();
  }

  return sendJson(
    res,
    200,
    {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 10,
        completion_tokens: words.length,
        total_tokens: 10 + words.length,
      },
    },
    { "x-harness-upstream": name }
  );
}

async function handleControl(req, res, name) {
  if (!NAME_PATTERN.test(name)) {
    return sendJson(res, 400, { error: { message: "invalid upstream name" } });
  }
  let patch;
  try {
    patch = parseJsonBody(await readBody(req));
  } catch {
    return sendJson(res, 400, { error: { message: "control body must be JSON" } });
  }
  const state = stateFor(name);
  if (patch.reset === true) {
    state.served = 0;
    state.failed = 0;
  }
  if (patch.mode !== undefined) {
    if (!MODES.has(patch.mode)) {
      return sendJson(res, 400, {
        error: { message: `mode must be one of ${[...MODES].join(", ")}` },
      });
    }
    state.mode = patch.mode;
  }
  if (patch.status !== undefined) {
    const status = Number(patch.status);
    if (!Number.isInteger(status) || status < 400 || status > 599) {
      return sendJson(res, 400, { error: { message: "status must be an integer 400-599" } });
    }
    state.status = status;
  }
  if (patch.latencyMs !== undefined) {
    const latency = Number(patch.latencyMs);
    if (!(latency >= 0 && latency <= 60000)) {
      return sendJson(res, 400, { error: { message: "latencyMs must be 0-60000" } });
    }
    state.latencyMs = latency;
  }
  if (patch.errorRate !== undefined) {
    const rate = Number(patch.errorRate);
    if (!(rate >= 0 && rate <= 1)) {
      return sendJson(res, 400, { error: { message: "errorRate must be 0-1" } });
    }
    state.errorRate = rate;
  }
  return sendJson(res, 200, { name, ...state });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || "/", "http://mock.local");
    const pathname = url.pathname;

    if (req.method === "GET" && pathname === "/__health") {
      return sendJson(res, 200, {
        ok: true,
        upstreams: Object.fromEntries(upstreams),
      });
    }

    const control = pathname.match(/^\/__control\/([^/]+)$/);
    if (req.method === "POST" && control) {
      return handleControl(req, res, control[1]);
    }

    const scoped = pathname.match(/^\/u\/([^/]+)(\/v1\/.*)$/);
    const name = scoped ? scoped[1] : "default";
    const v1Path = scoped ? scoped[2] : pathname;
    const state = stateFor(name);

    if (req.method === "GET" && v1Path === "/v1/models") {
      return sendJson(
        res,
        200,
        {
          object: "list",
          data: [{ id: MODEL_ID, object: "model", created: 0, owned_by: "harness-mock" }],
        },
        { "x-harness-upstream": name }
      );
    }

    if (req.method === "POST" && v1Path === "/v1/chat/completions") {
      return handleChat(req, res, name, state);
    }

    return sendJson(res, 404, {
      error: { message: `mock: no route for ${req.method} ${pathname}` },
    });
  } catch (error) {
    if (!res.headersSent) {
      sendJson(res, error.message === "request body too large" ? 413 : 500, {
        error: { message: "mock internal error" },
      });
    }
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[mock-upstream] listening on http://${HOST}:${PORT} (model ${MODEL_ID})`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
  });
}
