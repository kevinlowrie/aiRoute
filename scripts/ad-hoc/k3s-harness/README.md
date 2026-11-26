# k3s harness (ad-hoc)

Scripts for poking at an OmniRoute that runs on your laptop or in the k3s lab:
a smoke test, free-provider onboarding and probing, a fallback drill, a
tenant-isolation drill, and cleanup. They use only Node 22 built-ins, so there
is nothing to install. Every resource they create is named `harness-*`.

These are ad-hoc tools for learning and manual testing. They are not part of the
product test suite.

## Files

| File                                           | What it does                                                                                                                                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `smoke.mjs`                                    | Checks health and admin login, then makes a key, lists models, and optionally sends one chat.                                                                                                                                                                          |
| `free-onboarding.mjs`                          | Lists the providers that need no signup. With `--apply`, enables the ones you pick and builds a priority combo.                                                                                                                                                        |
| `free-pool-probe.mjs`                          | Sends N requests through a combo or model and reports success rate, which provider served each reply, error codes, and latency. Writes a JSON report.                                                                                                                  |
| `fallback-drill.mjs`                           | A failing provider comes first in a combo. Checks the client still gets 2xx and the failing provider stops getting traffic.                                                                                                                                            |
| `tenant-isolation.mjs`                         | Two tenants share one gateway. Checks the per-key cap, that one tenant's cap does not touch the other, cross-combo refusals, and that inference keys cannot reach the management API.                                                                                  |
| `device-gate.mjs`                              | The homelab Sprint 0 gate. A loopback router serves from its free pool, falls back to the edge when the pool is exhausted, and keeps a device key scoped to its own combo. Uses mocks for the pool and the edge. Set `EDGE_URL` to test against the real LiteLLM edge. |
| `run-all.mjs`                                  | Runs the drills in order and prints one pass or fail line for each.                                                                                                                                                                                                    |
| `cleanup.mjs`                                  | Lists and deletes `harness-*` resources. Dry run unless you pass `--apply`.                                                                                                                                                                                            |
| `mock-upstream.mjs`                            | A fake OpenAI-compatible provider with controllable failures and latency. Lets the drills run without spending real quota.                                                                                                                                             |
| `k8s/mock-upstream.yaml`, `k8s/deploy-mock.sh` | Deploys the mock into the lab namespace as a ConfigMap, Deployment, and ClusterIP Service.                                                                                                                                                                             |
| `lib.mjs`                                      | Shared helpers. Not run directly.                                                                                                                                                                                                                                      |

## Environment variables

| Variable                                      | Default                  | Meaning                                                                        |
| --------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------ |
| `OMNIROUTE_URL`                               | `http://localhost:20128` | Where the harness reaches OmniRoute.                                           |
| `OMNIROUTE_ADMIN_PASSWORD`                    | (none)                   | Dashboard admin password. Used to log in for management calls.                 |
| `OMNIROUTE_MANAGE_KEY`                        | (none)                   | Alternative to the password: an API key with `manage` scope.                   |
| `HARNESS_MOCK_UPSTREAM_URL`                   | `http://127.0.0.1:9100`  | URL OmniRoute uses to reach the mock. In k3s, use the in-cluster DNS name.     |
| `HARNESS_MOCK_CONTROL_URL`                    | same as above            | URL the harness uses to flip mock modes. In k3s, use the port-forward.         |
| `HARNESS_PROBE_KEY`                           | (none)                   | Inference key for `free-pool-probe.mjs`. If unset, a temporary key is created. |
| `HARNESS_PROBE_MODEL` / `HARNESS_SMOKE_MODEL` | (none)                   | Default `--model` for the probe and the smoke test.                            |
| `HARNESS_TAG`                                 | `harness-`               | Prefix on everything the harness creates.                                      |

Read the admin password from the environment. Do not paste it onto the command line,
where it would end up in shell history.

## Run it locally (no k3s)

```bash
# Terminal 1: OmniRoute (its own README covers setup)
npm run dev

# Terminal 2: the mock upstream
node scripts/ad-hoc/k3s-harness/mock-upstream.mjs

# Terminal 3: the harness
export OMNIROUTE_ADMIN_PASSWORD='your-admin-password'
node scripts/ad-hoc/k3s-harness/run-all.mjs
```

## Run it against the k3s lab

1. Deploy OmniRoute with `deploy/kubernetes/base` or the Helm chart. Create the
   Secret as described in `deploy/kubernetes/base/secret.example.yaml`.
2. Deploy the mock:

   ```bash
   scripts/ad-hoc/k3s-harness/k8s/deploy-mock.sh omniroute
   ```

3. Port-forward OmniRoute and the mock, in two terminals:

   ```bash
   kubectl -n omniroute port-forward svc/omniroute 20128:20128
   kubectl -n omniroute port-forward svc/harness-mock-upstream 9100:9100
   ```

4. Set the environment and run:

   ```bash
   export OMNIROUTE_URL=http://localhost:20128
   export OMNIROUTE_ADMIN_PASSWORD="$(kubectl -n omniroute get secret omniroute-secrets \
     -o jsonpath='{.data.INITIAL_PASSWORD}' | base64 -d)"
   export HARNESS_MOCK_UPSTREAM_URL=http://harness-mock-upstream.omniroute.svc.cluster.local:9100
   export HARNESS_MOCK_CONTROL_URL=http://localhost:9100

   node scripts/ad-hoc/k3s-harness/run-all.mjs
   ```

   If you changed the admin password in the dashboard, use that password instead
   of the one from the Secret.

## Things to try

```bash
# What free providers need no signup right now?
node scripts/ad-hoc/k3s-harness/free-onboarding.mjs

# Enable two of them and build a pool from them
node scripts/ad-hoc/k3s-harness/free-onboarding.mjs --apply \
  --providers uncloseai,duckduckgo-web --combo free-pool

# Measure the pool: 20 requests, 4 at a time, streamed
node scripts/ad-hoc/k3s-harness/free-pool-probe.mjs --model harness-free-pool \
  --requests 20 --concurrency 4 --stream --min-success 0.8

# Remove everything the harness created, plus those two providers
node scripts/ad-hoc/k3s-harness/cleanup.mjs --providers uncloseai,duckduckgo-web          # list
node scripts/ad-hoc/k3s-harness/cleanup.mjs --providers uncloseai,duckduckgo-web --apply  # delete
```

The fallback and tenant drills accept `--keep` to leave their resources in place
for manual poking. Remove them later with `cleanup.mjs`.

## Reading the output

- **served by** is the provider alias from the `X-OmniRoute-Decision` response
  header. For mock traffic, the harness reads the upstream name from the reply.
- **latency** from `npm run dev` is not representative. It runs in Turbopack
  development mode. Measure against a production build or the k3s image.
- **Free providers are third parties.** Their caution text comes from OmniRoute's
  provider metadata. A provider that stops working shows up as an error with its
  own code, not as a harness bug. A probe run is a snapshot of today.
- A reply with no `X-OmniRoute-Decision` header is counted and noted. The
  documentation says that header is always present on completion responses.

## Safety

- Nothing is deleted without `--apply`, and `cleanup.mjs` only touches `harness-*`
  names plus the providers you name.
- Secrets are read from the environment and redacted from printed output. Keys are
  never written to reports.
- `mock-upstream.mjs` has an unauthenticated control endpoint. Bind it to loopback
  locally, and in k3s expose it only through the ClusterIP Service. Do not add an
  Ingress.
- The probe measures free providers. It does not rotate accounts or otherwise try
  to get around a provider's limits. Keep request counts small, and respect each
  provider's terms.
- Reports go to `_artifacts/harness/`, which is gitignored.

## Known limits

- The k3s manifests were checked for YAML structure and the ConfigMap wiring. They
  have not been applied to a live cluster from this environment.
- **Streamed replies can lose the routing header under concurrency.** In the dev
  build, 27 of 30 streamed replies at concurrency 5 had no `X-OmniRoute-Decision`,
  while the non-streamed replies in the same test all had it. Reproduce it with
  `free-pool-probe.mjs --model <combo> --requests 30 --concurrency 5 --stream`. The
  cause is not yet known.
- If node creation fails with "Blocked private or local provider URL", the server
  has `OMNIROUTE_ALLOW_LOCAL_PROVIDER_URLS=false`. Set it back to `true` (the
  default) for the lab, because the mock lives on a private address.
- Management calls use the admin login. A scoped `manage` key would be a better fit
  for CI.
- The harness does not test the Electron desktop build directly. Any OmniRoute
  instance reachable over HTTP works, including a desktop one on `localhost:20128`.
