# Minikube Chaos Mesh Runbook for the Retention Delete Worker

## Scope and safety

This procedure is for a disposable local Minikube cluster only. It must not use production certificates, real audit records, real bearer tokens, or a production kubeconfig. Use synthetic PostgreSQL authorization rows, a disposable OpenSearch index, and a staging-only worker Secret.

The tests are opt-in because they alter pod clocks and network connectivity. Run them when no unrelated workload shares the selected worker pods.

## 1. Start Minikube

```bash
minikube start --cpus=4 --memory=8192 --driver=docker
minikube addons enable metrics-server
kubectl create namespace security --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace monitoring --dry-run=client -o yaml | kubectl apply -f -
```

Install Chaos Mesh using the version approved by the project. For a local cluster, the official Helm installation is preferred:

```bash
helm repo add chaos-mesh https://charts.chaos-mesh.org
helm repo update
helm upgrade --install chaos-mesh chaos-mesh/chaos-mesh \
  --namespace chaos-mesh --create-namespace \
  --set chaosDaemon.runtime=containerd \
  --set chaosDaemon.socketPath=/run/containerd/containerd.sock
kubectl -n chaos-mesh wait --for=condition=available deployment/chaos-controller-manager --timeout=5m
```

Verify the CRDs:

```bash
kubectl get crd timechaos.chaos-mesh.org networkchaos.chaos-mesh.org
```

## 2. Deploy the isolated stack

Build or load the worker image into Minikube:

```bash
eval "$(minikube docker-env)"
docker build -t umoja-retention-worker:chaos -f infra/retention-gateway/Dockerfile .
```

Create a disposable TLS Secret containing a staging-only client certificate, key, and OpenSearch CA. Do not commit the files:

```bash
kubectl -n security create secret generic umoja-retention-opensearch-client-tls \
  --from-file=ca.crt=secrets/opensearch-ca.pem \
  --from-file=tls.crt=secrets/worker.crt \
  --from-file=tls.key=secrets/worker.key \
  --dry-run=client -o yaml | kubectl apply -f -
```

Deploy PostgreSQL, OpenSearch, the worker, and monitoring using the local-only manifests or Compose-to-Kubernetes conversion. Confirm labels match the Chaos Mesh selectors:

```bash
kubectl -n security get pods --show-labels
kubectl -n security get pods -l app.kubernetes.io/name=umoja-retention-worker
kubectl -n security get pods -l app.kubernetes.io/name=opensearch
```

The worker must be Ready before injecting faults:

```bash
kubectl -n security rollout status deployment/umoja-retention-worker --timeout=10m
```

## 3. Prepare a synthetic worker execution

Set the worker URL, bearer token, and a JSON payload for a disposable authorization. Inject the values from a local secret manager or shell environment; do not place them in the repository:

```bash
export WORKER_SERVICE_URL=http://localhost:18080
export WORKER_BEARER_TOKEN="$(pass show staging/retention-worker-bearer)"
export WORKER_DELETE_PAYLOAD="$(cat /tmp/synthetic-delete-payload.json)"
```

Port-forward only to localhost:

```bash
kubectl -n security port-forward service/umoja-retention-worker 18080:8080 >/tmp/retention-worker-port-forward.log 2>&1 &
WORKER_PF_PID=$!
trap 'kill "$WORKER_PF_PID" 2>/dev/null || true' EXIT
```

Check baseline metrics:

```bash
curl --fail http://localhost:18080/healthz
curl --fail http://localhost:18080/metrics | grep '^umoja_retention_worker_'
```

## 4. Run the certificate-expiry test

Run the opt-in test with a short settle time:

```bash
RUN_CHAOS_MESH=1 \
CHAOS_NAMESPACE=security \
WORKER_SERVICE_URL="$WORKER_SERVICE_URL" \
WORKER_BEARER_TOKEN="$WORKER_BEARER_TOKEN" \
WORKER_DELETE_PAYLOAD="$WORKER_DELETE_PAYLOAD" \
CHAOS_SETTLE_SECONDS=15 \
python3 -m pytest -m chaos -q \
  tests/chaos_mesh/test_retention_worker_chaos.py \
  -k certificate_expiry_clock_skew
```

The test applies `TimeChaos` with a one-year clock offset to the worker pods, triggers a real worker execution, and expects a non-success response plus an OpenSearch authentication or authorization failure metric. The test removes the TimeChaos object and restarts the selected worker pods in cleanup.

Inspect the Chaos Mesh object and worker logs if the test fails:

```bash
kubectl -n security describe timechaos umoja-retention-worker-cert-expiry
kubectl -n security logs -l app.kubernetes.io/name=umoja-retention-worker --all-containers --tail=200
```

## 5. Run the mTLS network-partition test

```bash
RUN_CHAOS_MESH=1 \
CHAOS_NAMESPACE=security \
WORKER_SERVICE_URL="$WORKER_SERVICE_URL" \
WORKER_BEARER_TOKEN="$WORKER_BEARER_TOKEN" \
WORKER_DELETE_PAYLOAD="$WORKER_DELETE_PAYLOAD" \
CHAOS_SETTLE_SECONDS=15 \
python3 -m pytest -m chaos -q \
  tests/chaos_mesh/test_retention_worker_chaos.py \
  -k network_partition
```

The NetworkChaos object blocks bidirectional traffic between the worker and OpenSearch for 90 seconds. The worker request must fail, and the worker must report an execution or authentication failure. The test does not directly issue an OpenSearch delete.

Inspect the fault:

```bash
kubectl -n security describe networkchaos umoja-retention-worker-opensearch-partition
kubectl -n security get events --sort-by=.lastTimestamp | tail -50
```

## 6. Review Prometheus metrics

If Prometheus is deployed in the `monitoring` namespace, port-forward it locally:

```bash
kubectl -n monitoring port-forward service/prometheus 19090:9090 >/tmp/prometheus-port-forward.log 2>&1 &
PROM_PF_PID=$!
trap 'kill "$PROM_PF_PID" 2>/dev/null || true' EXIT
```

Query the worker health and scrape status:

```bash
curl -G --fail http://localhost:19090/api/v1/query \
  --data-urlencode 'query=up{job="umoja-retention-worker"}' | jq

curl -G --fail http://localhost:19090/api/v1/query \
  --data-urlencode 'query=umoja_retention_worker_health{job="umoja-retention-worker"}' | jq
```

Query security failures:

```bash
curl -G --fail http://localhost:19090/api/v1/query \
  --data-urlencode 'query=increase(umoja_retention_worker_failures_total{result="opensearch_authentication_failure"}[10m])' | jq

curl -G --fail http://localhost:19090/api/v1/query \
  --data-urlencode 'query=increase(umoja_retention_worker_failures_total{result="opensearch_authorization_failure"}[10m])' | jq
```

Query alert state:

```bash
curl -G --fail http://localhost:19090/api/v1/query \
  --data-urlencode 'query=ALERTS{alertname="UmojaRetentionWorkerSecurityFailureBurst"}' | jq
```

Expected results are a failed worker request, no unauthorized deletion, a security-failure result metric, and—if the failure count meets the configured threshold—the expected Prometheus alert. Alert evaluation may lag the request by the rule interval.

## 7. Verify no deletion bypass occurred

Confirm that the synthetic index remains present when the fault is active and that PostgreSQL authorization state is not silently recreated or marked successful. Reconcile the index identity and execution status after the fault clears.

```bash
curl --fail-with-body --cacert /tmp/opensearch-ca.pem \
  "$OPENSEARCH_URL/$TEST_INDEX/_settings/index.uuid,index.version"

psql "$DATABASE_URL" -c \
  "SELECT decision_digest, consumed_at, execution_status FROM retention_delete_authorizations WHERE correlation_id = 'chaos-test-001';"
```

## 8. Cleanup

The pytest cleanup removes the Chaos Mesh object. Confirm no faults remain:

```bash
kubectl -n security get timechaos,networkchaos
kubectl -n security rollout restart deployment/umoja-retention-worker
kubectl -n security rollout status deployment/umoja-retention-worker --timeout=10m
```

Remove local port-forwards, synthetic secrets, disposable indices, and test authorization records. Preserve only sanitized logs, metric responses, Chaos Mesh descriptions, and test results.

## Acceptance criteria

The local rehearsal passes only when the worker remains fail-closed during both faults, a valid mTLS path works before and after the tests, security metrics identify the failure, no unauthorized index deletion occurs, PostgreSQL authorization state remains auditable, and all Chaos Mesh resources are removed.
