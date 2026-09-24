#!/bin/sh
# Apply the Dapr Kafka pub/sub component and subscriptions.
# Closes the deployment wiring gap: infra/dapr held manifests that no
# pipeline applied. Services consuming these topics (reporting-analytics:
# com.dapr.event.sent / payment-order-validated / policy-decision events)
# require the kafka-pubsub component to exist before their sidecars start.
set -eu

NAMESPACE="${UMOJA_DAPR_NAMESPACE:-umoja-flow}"
SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
REPO_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/../.." && pwd)

if ! kubectl get crd components.dapr.io >/dev/null 2>&1; then
  echo "fail-closed: dapr CRDs not installed; install dapr control plane first" >&2
  exit 1
fi

kubectl -n "$NAMESPACE" apply -f "$REPO_ROOT/infra/dapr/components/kafka-pubsub.yaml"
for sub in "$REPO_ROOT"/infra/dapr/subscriptions/*.yaml; do
  kubectl -n "$NAMESPACE" apply -f "$sub"
done

kubectl -n "$NAMESPACE" get components.dapr.io
kubectl -n "$NAMESPACE" get subscriptions.dapr.io
echo "dapr pub/sub wiring applied to namespace $NAMESPACE"
