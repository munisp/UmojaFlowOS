# UmojaFlowOS Staging Evidence Commandbook

**Author:** Manus AI
**Target immutable release SHA:** `71b14909ec2cc9e373158120aab2c03953bb89fa`
**Scope:** Controlled staging only. Do not point any command at production data, customer accounts, production TigerBeetle, live regulatory recipients, or production PagerDuty.

> Commands that need credentials reference environment variables populated by the approved secret manager or CI environment. Do not echo the values, redirect secret-bearing environment output to logs, or place secrets in the evidence bundle.

## 0. Common setup and evidence-root creation

Run from a clean detached checkout of the exact release:

```bash
export RELEASE_SHA=71b14909ec2cc9e373158120aab2c03953bb89fa
export RELEASE_TAG="REPLACE_WITH_SIGNED_TAG_FOR_${RELEASE_SHA}"
export RUN_ID="staging-assurance-$(date -u +%Y%m%dT%H%M%SZ)"
export BUNDLE_DIR="/secure-release-evidence/${RELEASE_SHA}/${RUN_ID}"

mkdir -p "$BUNDLE_DIR"/{ci,migrations,ledger,integrations,deployment,observability,resilience,security,approvals}

git fetch --tags origin
git checkout --detach "$RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
printf 'release_sha=%s\nrun_id=%s\nenvironment=staging\ncreated_at=%s\n' \
  "$RELEASE_SHA" "$RUN_ID" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  > "$BUNDLE_DIR/ci/run-metadata.txt"
```

Set the staging endpoints through the approved secret-injection mechanism. The following variables are names only; their values must not be stored in the bundle:

```bash
export POSTGRES_DATABASE_URL="$(secret_ref staging/umoja/schema-owner-postgres-url)"
export POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL="$(secret_ref staging/umoja/test-schema-owner-postgres-url)"
export STAGING_KUBECONFIG_B64="$(secret_ref staging/umoja/kubeconfig-b64)"
export OPENSEARCH_URL="$(secret_ref staging/umoja/opensearch-url)"
export RETENTION_GATEWAY_URL="$(secret_ref staging/umoja/retention-gateway-url)"
```

Replace `secret_ref` with the organization-approved secret-manager command or use a protected CI secret mount. Never implement `secret_ref` as a shell alias that prints secrets into a build log.

## E-01 — Immutable provenance, review, build, and SBOM

```bash
git verify-tag "$RELEASE_TAG" |& tee "$BUNDLE_DIR/ci/e01-tag-verification.log"
git rev-list -n 1 "$RELEASE_TAG" | tee "$BUNDLE_DIR/ci/e01-tag-sha.txt"
test "$(cat "$BUNDLE_DIR/ci/e01-tag-sha.txt")" = "$RELEASE_SHA"
git status --porcelain | tee "$BUNDLE_DIR/ci/e01-clean-worktree.txt"

# Download/export these from the protected CI and review systems; do not fabricate them locally.
# ci/e01-review.json
# ci/e01-provenance.json
# ci/e01-image-digests.json
# ci/e01-sbom.spdx.json
```

E-01 passes only when the signed tag, protected review record, build provenance, SBOM, and immutable image digests are all bound to `RELEASE_SHA`.

## E-02 — Staging migration, schema, and grants evidence

```bash
POSTGRES_DATABASE_URL="$POSTGRES_DATABASE_URL" \
  make postgres-check |& tee "$BUNDLE_DIR/migrations/e02-schema-validation.log"

psql "$POSTGRES_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -c "SELECT version, applied_at FROM schema_migrations ORDER BY version" \
  | tee "$BUNDLE_DIR/migrations/e02-migration-ledger.tsv"

psql "$POSTGRES_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -c "SELECT current_database(), current_user" \
  | tee "$BUNDLE_DIR/migrations/e02-database-identity.txt"
```

Run the organization-approved staging migration job before this step and add its redacted log as `migrations/e02-migration-job.log`. The ledger must include migration `0042` exactly once.

## E-03 — Real PostgreSQL application-role workflow integration

```bash
cd apps/control-plane
POSTGRES_INTEGRATION_TEST=1 \
POSTGRES_DATABASE_URL="$POSTGRES_DATABASE_URL" \
POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL="$POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL" \
pnpm exec vitest run server/counterpartyOnboarding.integration.test.ts \
  --reporter=junit --outputFile="$BUNDLE_DIR/migrations/e03-postgres-integration.junit.xml"
cd ../..

make postgres-app-role-integration |& tee "$BUNDLE_DIR/migrations/e03-local-contract-check.log"
```

Add redacted staged role/grant review output as `migrations/e03-role-review.json` and correlation/outbox evidence as `migrations/e03-counterparty-correlation.json`. The actual staging job must use separate non-superuser application and schema-owner subjects.

## E-04 — TigerBeetle transfer, reconciliation, and failover

Load the approved non-customer staging account values from secret management, then run:

```bash
export TIGERBEETLE_LOADTEST_APPROVED=STAGING_ONLY_APPROVED
export TIGERBEETLE_LOADTEST_TARGET=staging
export TIGERBEETLE_LOADTEST_ADDRESS="$(secret_ref staging/umoja/tigerbeetle-address)"
export TIGERBEETLE_LOADTEST_CLUSTER_ID="$(secret_ref staging/umoja/tigerbeetle-cluster-id)"
export TIGERBEETLE_LOADTEST_NGN_LEDGER="$(secret_ref staging/umoja/tigerbeetle-ngn-ledger)"
export TIGERBEETLE_LOADTEST_ACCOUNT_CODE="$(secret_ref staging/umoja/tigerbeetle-account-code)"
export TIGERBEETLE_LOADTEST_TRANSFER_CODE="$(secret_ref staging/umoja/tigerbeetle-transfer-code)"
export TIGERBEETLE_LOADTEST_DEBIT_ACCOUNT_ID="$(secret_ref staging/umoja/tigerbeetle-debit-account-id)"
export TIGERBEETLE_LOADTEST_CREDIT_ACCOUNT_ID="$(secret_ref staging/umoja/tigerbeetle-credit-account-id)"
export TIGERBEETLE_LOADTEST_BATCH_SIZE=256
export TIGERBEETLE_LOADTEST_WORKERS=4
export TIGERBEETLE_LOADTEST_DURATION_SECONDS=60
export TIGERBEETLE_LOADTEST_METRICS_PATH="$BUNDLE_DIR/ledger/e04-loadtest.prom"

go run ./services/payment-engine/cmd/tigerbeetle-loadtest \
  | tee "$BUNDLE_DIR/ledger/e04-transfer-results.json"

export AUDIT_DATABASE_URL="$POSTGRES_DATABASE_URL"
export RECONCILIATION_SOURCE_IDENTITY="staging-assurance-${RUN_ID}"
export RUN_REFERENCE="${RUN_ID}-ledger-reconciliation"
export RECONCILIATION_METRICS_PATH="$BUNDLE_DIR/ledger/e04-reconciliation.prom"
scripts/infra/reconcile_tigerbeetle_postgres.sh \
  | tee "$BUNDLE_DIR/ledger/e04-reconciliation.txt"

# First capture the non-mutating plan.
EVIDENCE_DIR="$BUNDLE_DIR/ledger/failover" \
  scripts/infra/tigerbeetle_dr_failover.sh plan
```

Execute `tigerbeetle_dr_failover.sh execute` only during an independently approved staging DR window with all required hooks, `CONFIRM_DR_FAILOVER=APPROVED-TIGERBEETLE-FAILOVER`, fencing, reconciliation, and recovery evidence. Save the approved output as `ledger/e04-failover-drill.json`.

## E-05 — Keycloak, AML/CFT, webhooks, regulatory, WORM, and notification

Use recipient-owned staging destinations and execute the repository bridge/contract suites with their documented environment gates. Collect success and refusal evidence without payload secrets:

```bash
# Keycloak OIDC staging contract
KEYCLOAK_STAGING_INTEGRATION=1 \
KEYCLOAK_ISSUER_URL="$(secret_ref staging/umoja/keycloak-issuer-url)" \
KEYCLOAK_TEST_CLIENT_ID="$(secret_ref staging/umoja/keycloak-test-client-id)" \
python3 -m pytest -q tests -k 'keycloak or oidc' \
  |& tee "$BUNDLE_DIR/integrations/e05-keycloak-contract.log"

# Provider contract/staging suite. Populate only CI-secret references documented by the service owner.
UMOJA_EXTERNAL_INTEGRATION_TARGET=staging \
python3 -m pytest -q simulators tests -k 'aml or webhook or worm or notification or regulatory' \
  |& tee "$BUNDLE_DIR/integrations/e05-provider-contracts.log"
```

Store redacted correlation indexes, recipient receipts, HMAC/replay/CIDR refusal results, legal-hold/Object Lock metadata, detached-signature verification results, and notification test event IDs in `integrations/e05-index.json`.

## E-06 — Immutable deployment, health gates, and rollback

```bash
export KUBECONFIG="$(mktemp)"
printf '%s' "$STAGING_KUBECONFIG_B64" | base64 -d > "$KUBECONFIG"
chmod 0600 "$KUBECONFIG"

kubectl -n security get deployment,service,networkpolicy \
  | tee "$BUNDLE_DIR/deployment/e06-pre-rollout-inventory.txt"

# Use immutable image digest, never a mutable tag.
helm upgrade --install umoja-retention-worker \
  infra/retention-gateway/helm/umoja-retention-worker \
  --namespace security \
  --set image.repository=REPLACE_WITH_APPROVED_REGISTRY/umojaflowos-retention-worker \
  --set image.tag="sha256:REPLACE_WITH_APPROVED_DIGEST" \
  --atomic --wait --timeout 10m \
  |& tee "$BUNDLE_DIR/deployment/e06-rollout.log"

kubectl -n security rollout status deployment/umoja-retention-worker --timeout=10m \
  | tee "$BUNDLE_DIR/deployment/e06-rollout-status.txt"
kubectl -n security get pods -l app.kubernetes.io/name=umoja-retention-worker -o wide \
  | tee "$BUNDLE_DIR/deployment/e06-post-rollout-pods.txt"
```

Perform a separately approved rollback exercise using the repository staging deployment workflow or Helm revision rollback, then capture `e06-rollback.log` and `e06-post-rollback-health.json`.

## E-07 — Prometheus, Alertmanager, PagerDuty, and Grafana

```bash
kubectl -n security apply -f infra/retention-gateway/synthetic-monitor/prometheus-operator.yaml
kubectl -n security get servicemonitor,prometheusrule \
  | tee "$BUNDLE_DIR/observability/e07-monitoring-resources.txt"

PROMETHEUS_URL="$(secret_ref staging/umoja/prometheus-url)"
PROMETHEUS_TOKEN="$(secret_ref staging/umoja/prometheus-read-token)"
curl --fail-with-body -sS \
  -H "Authorization: Bearer $PROMETHEUS_TOKEN" \
  --get "$PROMETHEUS_URL/api/v1/query" \
  --data-urlencode 'query=up{monitoring_source="synthetic"}' \
  | tee "$BUNDLE_DIR/observability/e07-targets.json"

PROMTOOL_BIN="$(command -v promtool)" AMTOOL_BIN="$(command -v amtool)" \
  scripts/infra/validate_retention_monitoring_ci.sh \
  |& tee "$BUNDLE_DIR/observability/e07-route-test.txt"
```

Trigger only an approved non-production PagerDuty test event and store its incident ID. Export the populated Grafana dashboard JSON and rendered screenshot/export as `observability/e07-dashboard-export.json` and `observability/e07-dashboard.png`.

## E-08 — Backup/restore, circuit, Chaos, and recovery

```bash
export RUN_CHAOS_MESH=1
export CHAOS_NAMESPACE=security
export WORKER_SERVICE_URL="$(secret_ref staging/umoja/retention-worker-url)"
export WORKER_METRICS_URL="$(secret_ref staging/umoja/retention-worker-metrics-url)"
export SYNTHETIC_MONITOR_METRICS_URL="$(secret_ref staging/umoja/synthetic-monitor-metrics-url)"
export WORKER_BEARER_TOKEN="$(secret_ref staging/umoja/retention-worker-test-token)"
export WORKER_POOL_SATURATION_PAYLOADS_FILE="$(secret_ref staging/umoja/chaos-payload-fixture-path)"

python3 -m pytest -m chaos -q tests/chaos_mesh/test_retention_worker_chaos.py \
  --junitxml="$BUNDLE_DIR/resilience/e08-chaos.junit.xml" \
  |& tee "$BUNDLE_DIR/resilience/e08-chaos.log"
```

Run the approved backup restore job and TigerBeetle DR exercise in a staging maintenance window. Add restore identity, RTO/RPO measurement, before/during/after Prometheus evidence, Chaos cleanup proof, and reconciliation output. Never run this command or the associated fault manifests against production.

## E-09 — Security audit and independent review

```bash
python3 scripts/infra/validate_secret_material.py \
  |& tee "$BUNDLE_DIR/security/e09-secret-scan.log"

(
  cd apps/control-plane
  pnpm audit --prod --json
) > "$BUNDLE_DIR/security/e09-pnpm-audit.json"

# Export/download these from protected CI/security systems.
# security/e09-sbom-review.json
# approvals/e09-security-approval.json
```

## Build `release.json`, add approvals, and verify

Once actual artifacts exist, calculate hashes and generate the manifest. Do not copy the local dry-run approvals.

```bash
python3 - "$BUNDLE_DIR" "$RELEASE_SHA" <<'PY'
import hashlib, json, sys
from pathlib import Path
root, sha = Path(sys.argv[1]), sys.argv[2]
paths = {
  'E-01': 'ci/e01-provenance.json',
  'E-02': 'migrations/e02-schema-validation.log',
  'E-03': 'migrations/e03-postgres-integration.junit.xml',
  'E-04': 'ledger/e04-reconciliation.txt',
  'E-05': 'integrations/e05-index.json',
  'E-06': 'deployment/e06-rollout.log',
  'E-07': 'observability/e07-targets.json',
  'E-08': 'resilience/e08-chaos.junit.xml',
  'E-09': 'security/e09-pnpm-audit.json',
}
artifacts=[]
for evidence_id, rel in paths.items():
    path=root/rel
    if not path.is_file() or path.stat().st_size == 0:
        raise SystemExit(f'missing or empty required evidence: {rel}')
    artifacts.append({
        'evidence_id': evidence_id,
        'path': rel,
        'sha256': hashlib.sha256(path.read_bytes()).hexdigest(),
        'run_id': f'{evidence_id}-{root.name}',
    })
manifest={
    'release_sha': sha,
    'environment': 'staging',
    'created_at': __import__('datetime').datetime.now(__import__('datetime').timezone.utc).isoformat().replace('+00:00','Z'),
    'artifacts': artifacts,
    'approvals': json.loads((Path('assurance/production_signoff_approval_payload.template.json')).read_text()),
}
(root/'release.json').write_text(json.dumps(manifest, indent=2)+'\n')
PY

# Replace only the four placeholder subjects/timestamps with real independent approvals.
python3 scripts/infra/verify_production_release_evidence.py \
  --manifest "$BUNDLE_DIR/release.json" \
  --expected-sha "$RELEASE_SHA"
```

A zero verifier result enables independent review; it does not itself authorize a production rollout. A nonzero result is a mandatory NO-GO.
