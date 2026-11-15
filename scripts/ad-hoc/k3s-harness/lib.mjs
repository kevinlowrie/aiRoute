// Shared helpers for the k3s harness. Node 22 built-ins only, no dependencies.
//
// Every resource a drill creates is named with HARNESS_TAG (default "harness-"),
// so cleanup.mjs can find and remove leftovers later. Secrets come from the
// environment only and are redacted from anything printed.

import { performance } from "node:perf_hooks";

const trimSlash = (value) => value.replace(/\/+$/, "");
const positiveInt = (raw, fallback) => {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};

export const config = {
  omniUrl: trimSlash(process.env.OMNIROUTE_URL || "http://localhost:20128"),
  adminPassword: process.env.OMNIROUTE_ADMIN_PASSWORD || "",
  manageKey: process.env.OMNIROUTE_MANAGE_KEY || "",
  // URL OmniRoute uses to reach the mock (in-cluster DNS when running in k3s).
  mockUpstreamUrl: trimSlash(process.env.HARNESS_MOCK_UPSTREAM_URL || "http://127.0.0.1:9100"),
  // URL this harness uses to flip mock modes (a port-forward in k3s).
  mockControlUrl: trimSlash(
    process.env.HARNESS_MOCK_CONTROL_URL ||
      process.env.HARNESS_MOCK_UPSTREAM_URL ||
      "http://127.0.0.1:9100"
  ),
  tag: process.env.HARNESS_TAG || "harness-",
  timeoutMs: positiveInt(process.env.HARNESS_TIMEOUT_MS, 60_000),
};

export class HarnessError extends Error {}

export function die(message) {
  console.error(`\nERROR: ${redact(message)}`);
  process.exit(2);
}

export function tagged(name) {
  return `${config.tag}${name}`;
}

export function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

export function redact(text) {
  return String(text)
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, "sk-…redacted")
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, "$1…redacted");
}

async function readBody(res) {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

// ---- management API ------------------------------------------------------

let sessionCookie = null;

async function login() {
  if (!config.adminPassword) {
    die("Set OMNIROUTE_ADMIN_PASSWORD (or OMNIROUTE_MANAGE_KEY) before running the harness.");
  }
  const res = await fetch(`${config.omniUrl}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password: config.adminPassword }),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  const cookie = (res.headers.getSetCookie?.() ?? [])
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith("auth_token="));
  if (res.status !== 200 || !cookie) {
    throw new HarnessError(`login failed (HTTP ${res.status}). Check OMNIROUTE_ADMIN_PASSWORD.`);
  }
  sessionCookie = cookie;
}

async function managementHeaders() {
  if (config.manageKey) return { authorization: `Bearer ${config.manageKey}` };
  if (!sessionCookie) await login();
  return { cookie: sessionCookie };
}

function summarizeError(body) {
  if (body && typeof body === "object") {
    const message = body.error?.message ?? body.error ?? body.message;
    if (message) return redact(String(message)).slice(0, 240);
  }
  return redact(String(body ?? "")).slice(0, 240);
}

// Management call. Returns { status, ok, body } and never throws on HTTP errors.
export async function omni(method, path, { json } = {}) {
  const headers = await managementHeaders();
  if (json !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${config.omniUrl}${path}`, {
    method,
    headers,
    body: json === undefined ? undefined : JSON.stringify(json),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  return { status: res.status, ok: res.ok, body: await readBody(res) };
}

// Management call that throws a readable error on any non-2xx response.
export async function omniOk(method, path, options) {
  const result = await omni(method, path, options);
  if (!result.ok) {
    throw new HarnessError(
      `${method} ${path} -> HTTP ${result.status}: ${summarizeError(result.body)}`
    );
  }
  return result.body;
}

// Pages through a list endpoint. `field` is the array key in the response.
export async function listAll(resourcePath, field) {
  const limit = 100;
  const items = [];
  for (let page = 0; page < 50; page += 1) {
    const body = await omniOk("GET", `${resourcePath}?limit=${limit}&offset=${items.length}`);
    const batch = Array.isArray(body[field]) ? body[field] : [];
    items.push(...batch);
    if (batch.length === 0 || batch.length < limit || items.length >= (body.total ?? 0)) break;
  }
  return items;
}

// ---- resource helpers (every name gets the harness tag) ------------------

export async function createKey(name, extra = {}) {
  const body = await omniOk("POST", "/api/keys", { json: { name: tagged(name), ...extra } });
  return { id: body.id, key: body.key, name: body.name };
}

export async function patchKey(id, patch) {
  return omniOk("PATCH", `/api/keys/${encodeURIComponent(id)}`, { json: patch });
}

export async function createNode({ name, prefix, baseUrl }) {
  const body = await omniOk("POST", "/api/provider-nodes", {
    json: {
      name: tagged(name),
      prefix: tagged(prefix),
      type: "openai-compatible",
      baseUrl,
      apiType: "chat",
    },
  });
  return body.node;
}

export async function createConnection({ provider, apiKey, name }) {
  const body = await omniOk("POST", "/api/providers", {
    json: { provider, apiKey, name: tagged(name) },
  });
  return body.connection;
}

export async function createCombo({ name, strategy = "priority", models }) {
  return omniOk("POST", "/api/combos", { json: { name: tagged(name), strategy, models } });
}

// Deletes are best-effort during cleanup; the result is returned, not thrown.
export const deleteKey = (id) => omni("DELETE", `/api/keys/${encodeURIComponent(id)}`);
export const deleteNode = (id) => omni("DELETE", `/api/provider-nodes/${encodeURIComponent(id)}`);
export const deleteConnection = (id) => omni("DELETE", `/api/providers/${encodeURIComponent(id)}`);
export const deleteCombo = (id) => omni("DELETE", `/api/combos/${encodeURIComponent(id)}`);

// ---- inference -----------------------------------------------------------

// OmniRoute reports the routing decision in this header, for example:
//   strategy=priority; provider=openai-compatible-chat-<id>; latency_ms=256
export function parseDecision(raw) {
  if (!raw) return null;
  const fields = {};
  for (const part of raw.split(";")) {
    const index = part.indexOf("=");
    if (index > 0) fields[part.slice(0, index).trim()] = part.slice(index + 1).trim();
  }
  return {
    strategy: fields.strategy ?? null,
    provider: fields.provider ?? null,
    latencyMs: fields.latency_ms ? Number(fields.latency_ms) : null,
  };
}

// The mock upstream starts every reply with "[<name>] ". Real providers rarely do.
export function mockTagFrom(content) {
  const match = typeof content === "string" ? content.match(/^\[([a-z0-9-]+)\] /) : null;
  return match ? match[1] : null;
}

export async function chat({
  key,
  model,
  prompt = "Say hi in three words.",
  maxTokens = 32,
  stream = false,
  timeoutMs = config.timeoutMs,
}) {
  const started = performance.now();
  let res;
  try {
    res = await fetch(`${config.omniUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        stream,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return {
      status: 0,
      latencyMs: performance.now() - started,
      ttfbMs: null,
      decision: null,
      content: null,
      mockTag: null,
      errorCode: "network_error",
      errorMessage: redact(error.message).slice(0, 240),
      diagnostics: null,
    };
  }

  let ttfbMs = null;
  let text = "";
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (ttfbMs === null) ttfbMs = performance.now() - started;
      text += decoder.decode(value, { stream: true });
    }
  }
  const latencyMs = performance.now() - started;

  let body = null;
  let content = null;
  if (stream) {
    const pieces = text
      .split("\n")
      .filter((line) => line.startsWith("data: ") && !line.includes("[DONE]"))
      .map((line) => {
        try {
          return JSON.parse(line.slice(6)).choices?.[0]?.delta?.content ?? "";
        } catch {
          return "";
        }
      });
    content = pieces.join("");
  } else {
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    content = body?.choices?.[0]?.message?.content ?? null;
  }

  const ok = res.status >= 200 && res.status < 300;
  return {
    status: res.status,
    latencyMs,
    ttfbMs,
    decision: parseDecision(res.headers.get("x-omniroute-decision")),
    content,
    mockTag: mockTagFrom(content),
    errorCode: ok ? null : (body?.error?.code ?? (body ? "unknown" : "non_json_error")),
    errorMessage: ok ? null : redact(body?.error?.message ?? text).slice(0, 240),
    diagnostics: body?.diagnostics ?? null,
  };
}

// ---- mock upstream control ----------------------------------------------

export const MOCK_MODEL = process.env.HARNESS_MOCK_MODEL || "harness-mock-model";

export const mockBaseUrl = (name) => `${config.mockUpstreamUrl}/u/${name}/v1`;

// Counters for one fake upstream: { mode, served, failed, ... } or null.
export async function mockState(name) {
  try {
    const res = await fetch(`${config.mockControlUrl}/__health`, {
      signal: AbortSignal.timeout(5000),
    });
    const body = await readBody(res);
    return body?.upstreams?.[name] ?? null;
  } catch {
    return null;
  }
}

export async function mockControl(name, patch) {
  const res = await fetch(`${config.mockControlUrl}/__control/${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!res.ok) {
    throw new HarnessError(
      `mock control for "${name}" failed: HTTP ${res.status}. Is the mock running at ${config.mockControlUrl}?`
    );
  }
  return readBody(res);
}

export async function mockHealthy() {
  try {
    const res = await fetch(`${config.mockControlUrl}/__health`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ---- reporting -----------------------------------------------------------

export function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

export function ms(value) {
  return value === null || value === undefined ? "-" : `${Math.round(value)} ms`;
}

export function printTable(rows, columns) {
  const widths = columns.map((column) =>
    Math.max(column.label.length, ...rows.map((row) => String(row[column.key] ?? "").length))
  );
  const line = (values) =>
    values.map((value, i) => String(value ?? "").padEnd(widths[i])).join("  ");
  console.log(line(columns.map((column) => column.label)));
  console.log(widths.map((width) => "-".repeat(width)).join("  "));
  for (const row of rows) console.log(line(columns.map((column) => row[column.key])));
}

// Runs `task(index)` for every index with at most `concurrency` in flight.
export async function runPool(count, concurrency, task) {
  const results = new Array(count);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) {
      const index = next;
      next += 1;
      results[index] = await task(index);
    }
  });
  await Promise.all(workers);
  return results;
}

// Known harness errors print one clean line; anything unexpected keeps its stack.
export function runMain(main) {
  main().catch((error) => {
    if (error instanceof HarnessError) die(error.message);
    console.error(error);
    process.exit(1);
  });
}

export function createChecks() {
  const results = [];
  return {
    check(label, passed, detail = "") {
      results.push({ label, passed: Boolean(passed) });
      console.log(`${passed ? "PASS" : "FAIL"}  ${label}${detail ? `  (${redact(detail)})` : ""}`);
      return Boolean(passed);
    },
    finish() {
      const failed = results.filter((r) => !r.passed).length;
      console.log(`\n${results.length - failed}/${results.length} checks passed`);
      process.exitCode = failed === 0 ? 0 : 1;
    },
  };
}

export async function preflight({ needMock = false } = {}) {
  try {
    const res = await fetch(`${config.omniUrl}/healthz`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    console.log(`OmniRoute reachable at ${config.omniUrl}`);
  } catch (error) {
    die(
      `OmniRoute not reachable at ${config.omniUrl} (${error.message}). ` +
        "Start it locally or port-forward the k3s Service (see README.md)."
    );
  }
  if (needMock && !(await mockHealthy())) {
    die(
      `Mock upstream not reachable at ${config.mockControlUrl}. ` +
        "Start scripts/ad-hoc/k3s-harness/mock-upstream.mjs or deploy k8s/deploy-mock.sh."
    );
  }
}
