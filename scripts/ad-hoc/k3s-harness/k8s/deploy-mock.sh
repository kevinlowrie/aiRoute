#!/usr/bin/env bash
# Deploys the harness mock upstream into the lab namespace.
#
# Usage: scripts/ad-hoc/k3s-harness/k8s/deploy-mock.sh [namespace]
#   Namespace defaults to $HARNESS_NAMESPACE, then "omniroute" (the base manifests' namespace).
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ns="${1:-${HARNESS_NAMESPACE:-omniroute}}"

kubectl -n "$ns" create configmap harness-mock-upstream \
  --from-file=mock-upstream.mjs="$here/../mock-upstream.mjs" \
  --dry-run=client -o yaml | kubectl apply -f -

kubectl apply -n "$ns" -f "$here/mock-upstream.yaml"

# A ConfigMap change is not picked up by a running pod, so restart to load it.
kubectl -n "$ns" rollout restart deploy/harness-mock-upstream
kubectl -n "$ns" rollout status deploy/harness-mock-upstream --timeout=180s

echo
echo "Mock upstream is up in namespace $ns."
echo "OmniRoute reaches it at: http://harness-mock-upstream.$ns.svc.cluster.local:9100"
echo "Control it from your laptop with: kubectl -n $ns port-forward svc/harness-mock-upstream 9100:9100"
