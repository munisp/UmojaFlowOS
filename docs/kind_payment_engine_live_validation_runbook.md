# Local Kind payment-engine live validation runbook

## Scope

This runbook provisions an isolated Kind cluster, installs the Kubernetes/Helm tooling, deploys the payment-engine Helm chart, exposes the Prometheus Adapter external metric `umoja_fabric_queue_depth`, and validates HPA behavior under an approved queue-load generator. It must use a disposable image, database, Vault path, object-storage bucket, and release-evidence bundle. It must never use production credentials or a production WORM bucket.

The automated entrypoint is:

```bash
scripts/infra/run_kind_payment_engine_validation.sh
```

The runner fails closed when Docker, Kind, kubectl, Helm, the required Helm values file, or a reachable cluster is unavailable. Tool downloads require SHA-256 values by default. `ALLOW_UNVERIFIED_DOWNLOADS=true` is permitted only for a disposable local workstation and must not be used in CI or production.

## Required host prerequisites

Docker must be installed and the daemon must be running. The runner installs pinned binaries into `.tools/bin` and does not modify the host-wide PATH. For a verified setup, obtain the release SHA-256 values from the official Kubernetes, Helm, and Kind release pages and export them before execution:

```bash
export KUBECTL_SHA256='<official kubectl checksum>'
export HELM_SHA256='<official helm archive checksum>'
export KIND_SHA256='<official kind checksum>'
```

For a disposable local-only rehearsal where checksum values are intentionally supplied later, the runner can be bootstrapped with:

```bash
export ALLOW_UNVERIFIED_DOWNLOADS=true
```

This option disables download verification and is not acceptable for a release pipeline.

## Isolated Helm values

Create a local values file outside Git. It must contain a real disposable image digest and isolated test dependencies:

```yaml
image:
  repository: ghcr.io/munisp/umojaflowos-payment-engine
  digest: "sha256:<64-hex-test-image-digest>"
  pullPolicy: IfNotPresent

environment: staging

releaseEvidence:
  existingClaim: umoja-release-evidence-test
  manifestPath: /var/run/umoja/release/manifest.json
  signaturesDir: /var/run/umoja/release/signatures

objectStorage:
  endpoint: http://minio.minio.svc.cluster.local:9000
  bucket: umoja-release-evidence-test
  region: us-east-1
  useSSL: false
  canaryKey: releases/test/canary.json
  credentialsSecret: umoja-object-storage-credentials

vault:
  enabled: false
  address: ""
  objectStorageSecretPath: ""

postgres:
  existingSecret: umoja-postgres-credentials
  urlKey: queue-database-url
  maxOpenConns: 16
  maxIdleConns: 8
  connMaxLifetime: 30m
  connMaxIdleTime: 5m

fabric:
  queueWorkers: 2
  admissionLimit: 4
  leaseDuration: 90s
  pollInterval: 250ms
  metricsRefreshInterval: 5s
  commitStatusTimeout: 30s

hpa:
  enabled: true
  minReplicas: 2
  maxReplicas: 8
  queueDepthAverageValue: "50"
  scaleUpStabilizationSeconds: 60
  scaleUpPods: 2
  scaleUpPeriodSeconds: 60
  scaleDownStabilizationSeconds: 300
  scaleDownPods: 1
  scaleDownPeriodSeconds: 120
```

The test manifest, four detached signatures, PVC, PostgreSQL Secret, and object-storage Secret must be created independently. The image digest must be verified by Cosign before deployment. The chart must not be given a mutable tag or a placeholder digest.

## Provision and deploy

From the repository root:

```bash
export HELM_VALUES_FILE="$PWD/.local/kind-payment-engine-values.yaml"
export KUBECTL_SHA256='<official checksum>'
export HELM_SHA256='<official checksum>'
export KIND_SHA256='<official checksum>'

scripts/infra/run_kind_payment_engine_validation.sh
```

The runner creates or reuses Kind cluster `umoja-staging`, switches to context `kind-umoja-staging`, creates namespaces `umoja-payment` and `observability`, applies the Prometheus Adapter metric configuration, installs the Helm release, waits for rollout, and records all evidence under:

```text
artifacts/staging/kind-validation/<UTC-timestamp>/
```

## Prometheus and Adapter prerequisites

The runner applies the repository’s ConfigMap and alert rules, but it does not install a Prometheus server or Prometheus Adapter. Install both in the isolated cluster using pinned chart versions and a disposable values file. Prometheus must scrape the payment-engine metrics Service and expose `umoja_fabric_queue_depth{state="pending",namespace="umoja-payment"}`.

After installation, verify:

```bash
kubectl -n observability get pods,svc
kubectl -n observability get --raw /apis/external.metrics.k8s.io/v1beta1 | jq .
kubectl get --raw '/apis/external.metrics.k8s.io/v1beta1/namespaces/umoja-payment/umoja_fabric_queue_depth' | jq .
```

The external-metrics response must be non-empty, namespaced to `umoja-payment`, and contain a current value. An HTTP 404, an empty response, a stale timestamp, or a value from another namespace is a hard failure.

Verify the HPA contract:

```bash
kubectl -n umoja-payment get hpa -o yaml
kubectl -n umoja-payment describe hpa
kubectl -n umoja-payment get --raw '/apis/autoscaling/v1/namespaces/umoja-payment/scale/umoja-payment-engine-umoja-payment-engine' | jq .
```

The HPA must report a valid external metric target, no `FailedGetExternalMetric` condition, and no `ScalingActive=false` condition caused by metric discovery.

## Live queue-load validation

Use an approved disposable queue-load generator that submits valid queue work to the staging API or inserts test records through the documented test fixture path. Do not invent a production payment request and do not write directly to the production database.

Capture a baseline:

```bash
kubectl -n umoja-payment get pods -o wide
kubectl -n umoja-payment get hpa -o json > artifacts/staging/kind-validation/hpa-baseline.json
kubectl -n umoja-payment get --raw '/apis/external.metrics.k8s.io/v1beta1/namespaces/umoja-payment/umoja_fabric_queue_depth' > artifacts/staging/kind-validation/metric-baseline.json
```

During the controlled load, sample every 15 seconds for at least 10 minutes:

```bash
while true; do
  date -u +%FT%TZ
  kubectl -n umoja-payment get hpa -o json
  kubectl -n umoja-payment get --raw '/apis/external.metrics.k8s.io/v1beta1/namespaces/umoja-payment/umoja_fabric_queue_depth'
  kubectl -n umoja-payment get pods --no-headers
  sleep 15
done | tee artifacts/staging/kind-validation/hpa-live-samples.log
```

Record pod startup latency from the first HPA replica-count increase to the new pod’s `Ready=True` transition. Record queue wait and end-to-end job latency from worker timestamps, not from HPA status alone. The test passes only when queue depth rises under load, the external metric remains available, replicas increase within the approved policy window, the queue drains after load stops, and scale-down follows the five-minute stabilization and 120-second one-pod period.

## Required negative checks

The live validation must also verify:

```bash
kubectl -n umoja-payment get events --sort-by=.lastTimestamp
kubectl -n umoja-payment describe hpa
kubectl -n observability logs deploy/prometheus-adapter --tail=200
```

A missing metric, adapter outage, namespace mismatch, invalid image digest, absent release PVC, missing signature, invalid WORM binding, or unavailable PostgreSQL dependency must block promotion. No test may treat an HPA with a zero or absent metric as healthy.

## Evidence and cleanup

Save the following in the timestamped evidence directory:

- Tool and cluster versions.
- Helm values checksum, with secrets excluded.
- Rendered Helm manifests.
- Pod readiness timestamps.
- HPA JSON samples.
- External-metrics API responses.
- Prometheus query responses.
- Adapter logs and events.
- Queue latency histograms.
- Final replica and queue state.
- Signed release manifest and detached-signature verification output.

After review, destroy the disposable cluster:

```bash
kind delete cluster --name umoja-staging
```

Deletion is not a substitute for evidence retention. Copy approved evidence to the configured WORM bucket, verify the returned object checksum and Object Lock retention, and bind the object key, retention timestamp, release SHA, and reconciliation run ID into the signed manifest before declaring the rehearsal complete.

## Production interpretation

A successful Kind run proves local integration of the chart, metrics API, and HPA mechanics only. It does not prove production readiness for PostgreSQL capacity, Fabric endorsement/commit latency, Vault rotation, S3 WORM behavior, Istio mTLS, OTel telemetry, HSM operations, disaster recovery, or regulatory approval. Those gates require authorized staging evidence.

## Production GO gate

A successful local Kind rehearsal is not production authorization. Before promotion, run the machine-enforced gate from the checked-out release commit with protected environment paths pointing to the approved evidence bundle:

```bash
python3 scripts/infra/verify_release_manifest_signatures.py \
  --manifest "$PRODUCTION_RELEASE_MANIFEST" \
  --schema assurance/release_evidence_manifest.schema.json \
  --signatures-dir "$PRODUCTION_SIGNATURES_DIR" \
  --expected-sha "$RELEASE_SHA"

python3 scripts/infra/validate_production_go_gate.py \
  --evidence-dir "$PRODUCTION_EVIDENCE_DIR" \
  --manifest "$PRODUCTION_RELEASE_MANIFEST" \
  --signatures-dir "$PRODUCTION_SIGNATURES_DIR" \
  --image "$IMAGE@sha256:<64-hex-digest>"
```

The gate returns `production_go: true` only when all required live evidence files exist, the HPA/external-metrics validator reports `status: PASS` with `live_cluster_evidence: true`, the image is immutable, the manifest contains a future WORM retention timestamp and reconciliation run ID, and exactly the four required detached approval sidecars are present. It returns non-zero for missing, simulated, stale, unsigned, or structurally incomplete evidence.

The protected CI environment must define `PRODUCTION_EVIDENCE_DIR`, `PRODUCTION_RELEASE_MANIFEST`, and `PRODUCTION_SIGNATURES_DIR` as paths accessible in the runner workspace. The canonical Python Ed25519 verifier is invoked before the GO gate; structural presence of four files is never accepted as a substitute for signature validation.

The required live evidence set is:

```text
cluster_version.txt
rollout-status.txt
workload-state.yaml
adapter-hpa-validation-final.json
hpa-live-samples.log
metric-baseline.json
postgres-contention.json
istio-mtls-rbac.json
otel-trace-health.json
fabric-commit-latency.json
vault-rotation-canary.json
worm-object-lock.json
hsm-key-custody.json
dr-recovery.json
```

The following remain external prerequisites and cannot be generated honestly by a repository-only run: Docker/Kind or an authorized Kubernetes cluster, Prometheus and Prometheus Adapter, PostgreSQL 16 load evidence, Istio STRICT/RBAC evidence, OTel traces, multi-peer Fabric endorsement and commit evidence, live Vault rotation, S3-compatible 401/403 recovery, WORM Object Lock verification, HSM custody evidence, and an authorized disaster-recovery rehearsal. Until those artifacts are captured and independently approved, the correct status is NO-GO.

## Tool-installation security requirements

The runner pins kubectl, Helm, and Kind versions. Every new download and every cached executable is checksum-verified when the corresponding `KUBECTL_SHA256`, `HELM_SHA256`, `KIND_SHA256`, or `HELM_BINARY_SHA256` value is supplied. Missing checksums are allowed only for an explicitly disposable local run with `ALLOW_UNVERIFIED_DOWNLOADS=true`; that override is rejected whenever `CI=true`. CI and production must provide official release checksums and must not rely on unverified downloads.

The runner executes repository-static validation before checking Docker, so missing container tooling still produces useful static evidence. It never treats the absence of Docker, a cluster, or external metrics as a successful live validation.

## Current readiness decision

The repository implementation is **conditionally staging-ready but not production GO**. The code and static gates are implemented; live infrastructure evidence and regulated operational approvals remain mandatory. A production deployment must be blocked unless the machine-enforced GO gate returns `production_go: true` and the four approval roles independently sign the exact release manifest.

References: [1] [Kubernetes kubectl release verification](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/) [2] [Helm installation and releases](https://helm.sh/docs/intro/install/) [3] [Kind quick start](https://kind.sigs.k8s.io/docs/user/quick-start/)

[1]: https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/
[2]: https://helm.sh/docs/intro/install/
[3]: https://kind.sigs.k8s.io/docs/user/quick-start/
