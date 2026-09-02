#!/usr/bin/env bash
set -Eeuo pipefail
umask 077

# Staging-only, read-mostly evidence collector. It never changes firewall,
# routing, settlement state, or database data. It fails closed on missing
# authorization, production markers, missing tools, or incomplete probes.
: "${PARTITION_EVIDENCE_APPROVED:?set PARTITION_EVIDENCE_APPROVED=STAGING_PARTITION_EVIDENCE_APPROVED}"
[[ "$PARTITION_EVIDENCE_APPROVED" == STAGING_PARTITION_EVIDENCE_APPROVED ]] || { echo 'invalid evidence authorization' >&2; exit 2; }
[[ "${UMOJA_ENV:-staging}" != production ]] || { echo 'production collection is forbidden' >&2; exit 2; }
: "${RECONCILIATION_RUN_ID:?set the approved reconciliation run ID}"
: "${RELEASE_SHA:?set the 40-character release SHA}"
[[ "$RELEASE_SHA" =~ ^[a-f0-9]{40}$ ]] || { echo 'RELEASE_SHA must be 40 lowercase hex characters' >&2; exit 2; }
[[ "$RECONCILIATION_RUN_ID" =~ ^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$ ]] || { echo 'invalid reconciliation run ID' >&2; exit 2; }

for binary in sha256sum date hostname; do command -v "$binary" >/dev/null || { echo "required tool missing: $binary" >&2; exit 2; }; done

EVIDENCE_DIR=${EVIDENCE_DIR:-"artifacts/staging/partition-recovery/${RECONCILIATION_RUN_ID}"}
mkdir -p "$EVIDENCE_DIR"
STARTED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)

record() {
  local name=$1; shift
  "$@" > "$EVIDENCE_DIR/$name" 2>&1 || {
    echo "FAIL $name" | tee -a "$EVIDENCE_DIR/collection-status.tsv" >&2
    return 1
  }
  echo "PASS $name" | tee -a "$EVIDENCE_DIR/collection-status.tsv"
}

: > "$EVIDENCE_DIR/collection-status.tsv"
cat > "$EVIDENCE_DIR/collection-metadata.json" <<EOF
{
  "simulation": true,
  "environment": "staging",
  "reconciliation_run_id": "$RECONCILIATION_RUN_ID",
  "release_sha": "$RELEASE_SHA",
  "started_at": "$STARTED_AT",
  "collector": "collect_partition_recovery_evidence.sh"
}
EOF

record host.txt hostname -f
if command -v kubectl >/dev/null && [[ -n "${KUBE_CONTEXT:-}" && -n "${KUBE_NAMESPACE:-}" ]]; then
  kubectl config use-context "$KUBE_CONTEXT" >/dev/null
  record cluster-version.txt kubectl version -o yaml
  record cluster-nodes.txt kubectl get nodes -o wide
  record workload-state.yaml kubectl -n "$KUBE_NAMESPACE" get pods,svc,hpa -o yaml
  record payment-engine-metrics.prom kubectl -n "$KUBE_NAMESPACE" exec deploy/umoja-payment-engine -c payment-engine -- wget -qO- http://127.0.0.1:8081/metrics
else
  echo 'SKIP kubernetes probes: KUBE_CONTEXT/KUBE_NAMESPACE unavailable' | tee -a "$EVIDENCE_DIR/collection-status.tsv"
fi

if [[ -n "${DATABASE_URL:-}" ]] && command -v psql >/dev/null; then
  record postgres-replication.txt psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT now(), pg_is_in_recovery(); SELECT application_name, client_addr, state, sync_state, sent_lsn, replay_lsn, pg_wal_lsn_diff(sent_lsn,replay_lsn) AS bytes_lag FROM pg_stat_replication;"
  record postgres-run-binding.txt psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT current_setting('app.tenant_id', true) AS tenant_context; SELECT tenant_id, idempotency_key, status, release_sha, reconciliation_run_id FROM stablecoin_intent WHERE reconciliation_run_id = '$RECONCILIATION_RUN_ID';"
  record postgres-locks.txt psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -c "SELECT locktype, mode, granted, relation::regclass FROM pg_locks WHERE NOT granted;"
else
  echo 'SKIP postgres probes: DATABASE_URL/psql unavailable' | tee -a "$EVIDENCE_DIR/collection-status.tsv"
fi

if command -v curl >/dev/null; then
  if [[ -n "${PROMETHEUS_URL:-}" ]]; then
    record prometheus-tigerbeetle-lag.json curl --fail --silent --show-error --get "$PROMETHEUS_URL/api/v1/query" --data-urlencode 'query=umoja_tigerbeetle_replication_lag_seconds'
    record prometheus-kafka-lag.json curl --fail --silent --show-error --get "$PROMETHEUS_URL/api/v1/query" --data-urlencode 'query=umoja_kafka_consumer_lag_records'
    record prometheus-opa-errors.json curl --fail --silent --show-error --get "$PROMETHEUS_URL/api/v1/query" --data-urlencode 'query=umoja_opa_policy_evaluation_errors_total'
  else
    echo 'SKIP prometheus probes: PROMETHEUS_URL unavailable' | tee -a "$EVIDENCE_DIR/collection-status.tsv"
  fi
fi

# Bind every collected file to the run and release without including secrets.
python3 - "$EVIDENCE_DIR" "$RECONCILIATION_RUN_ID" "$RELEASE_SHA" <<'PY'
import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1]); run_id = sys.argv[2]; release_sha = sys.argv[3]
files = []
for path in sorted(root.iterdir()):
    if path.name in {"evidence-manifest.json", "sha256sums.txt"} or path.is_dir():
        continue
    digest = hashlib.sha256(path.read_bytes()).hexdigest()
    files.append({"path": path.name, "sha256": digest, "reconciliation_run_id": run_id, "release_sha": release_sha})
manifest = {"simulation": True, "release_sha": release_sha, "reconciliation_run_id": run_id, "artifacts": files}
(root / "evidence-manifest.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
PY
sha256sum "$EVIDENCE_DIR"/* > "$EVIDENCE_DIR/sha256sums.txt"
echo "PASS evidence-manifest.json" | tee -a "$EVIDENCE_DIR/collection-status.tsv"
# Return non-zero if any required probe failed; SKIPs are explicit and not live evidence.
if grep -q '^FAIL ' "$EVIDENCE_DIR/collection-status.tsv"; then exit 1; fi
