# Production approval and staging financial reconciliation runbook

This runbook describes the controlled path from a reviewed release to production approval. It does not authorize production by itself. Real staging artifacts, real approver identities, protected signatures, and external-system results remain mandatory.

## Four independent production approvals

The release manifest must contain exactly the four required roles. Each approver must be a distinct human or organization-controlled identity and must review the evidence relevant to that role. Every approval is bound to the exact lowercase 40-character `release_sha` and includes only `role`, `subject`, `release_sha`, and timezone-qualified `approved_at`.

| Role | Required review | Evidence to approve |
|---|---|---|
| `release_manager` | Release identity, immutable source ref, build reproducibility, deployment package, rollback readiness, and change record | Signed tag verification, source SHA, image digest, build provenance, SBOM, deployment plan, rollback plan, and release checklist |
| `security_owner` | Threat model, secret handling, mTLS, RBAC, network policy, dependency risk, vulnerability results, and incident response | Security test results, secret-scan result, SBOM review, mTLS/RBAC evidence, penetration/security review, alert delivery, and exception register |
| `compliance_owner` | CBN/VASP control coverage, AML/CFT/CPF, sanctions, Travel Rule, record retention, WORM/legal hold, consumer protection, and regulatory reporting | Controlled compliance artifacts, real provider evidence, WORM verification, case/audit immutability, regulatory submission controls, and residual-risk acceptance |
| `operations_owner` | Staging deployment, health gates, paging, rollback, backup/restore, failover, Chaos, RTO/RPO, and on-call readiness | Deployment and rollback receipts, monitoring/paging delivery, restore result, failover result, Chaos report, recovery timings, and runbook sign-off |

The exact validator is:

```bash
python3 scripts/infra/verify_production_release_evidence.py \
  --manifest assurance/evidence/release.json \
  --repo .
```

The verifier must reject incomplete artifacts, bad hashes, an environment outside the accepted staging/production set, a manifest bound to another SHA, duplicate subjects, missing roles, malformed timestamps, or approvals that contain extra fields. Placeholder identities are never valid approval subjects.

The four approvers should review the same immutable evidence bundle independently. The release manager must not replace the security, compliance, or operations review. A disagreement, missing evidence item, or unresolved exception leaves the decision at `NO-GO`.

## PostgreSQL/TigerBeetle staging reconciliation sequence

Financial reconciliation must run only after the staging schema has been migrated and the TigerBeetle facts have been projected into PostgreSQL. PostgreSQL is the control-plane record; TigerBeetle is the double-entry fact source. A successful TigerBeetle API call is not a customer-visible settlement until its fact is projected, matched, and reconciled.

### 1. Prepare an approved staging release

```bash
export RELEASE_SHA=768579f891867319e4553723500fcde79f66f3bd
export RUN_ID="staging-reconciliation-$(date -u +%Y%m%dT%H%M%SZ)"
export EVIDENCE_DIR="/secure-release-evidence/${RELEASE_SHA}/${RUN_ID}"

mkdir -p "$EVIDENCE_DIR"/{ledger,reconciliation}
git fetch origin --tags --prune
git checkout --detach "$RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
```

Use an approved staging PostgreSQL secret reference. Do not put the URL in Git, shell history, workflow logs, or evidence files.

### 2. Apply and verify the canonical PostgreSQL schema

```bash
export POSTGRES_DATABASE_URL="$(secret_ref staging/umoja/schema-owner-postgres-url)"

POSTGRES_DATABASE_URL="$POSTGRES_DATABASE_URL" \
  scripts/infra/apply_postgres_migrations.sh

psql "$POSTGRES_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f database/postgresql/validate_schema.sql \
  > "$EVIDENCE_DIR/reconciliation/schema-validation.txt"
```

The schema gate must show the migration ledger in a successful state and the reconciliation columns in place, including `ledger_reconciliation_runs.status`, `run_reference`, `intent_count`, `fact_count`, `discrepancy_count`, and `source_identity`, together with `ledger_reconciliation_discrepancies.discrepancy_code`, `expected`, and `observed`. Any checksum drift, interrupted migration, missing column, privilege failure, or existing-database drift stops the run.

### 3. Confirm the TigerBeetle staging contract

The cluster must be a real approved staging cluster, not a simulator. The protected values are:

```text
TIGERBEETLE_STAGING_ADDRESS
TIGERBEETLE_STAGING_CLUSTER_ID
TIGERBEETLE_STAGING_NGN_LEDGER
TIGERBEETLE_STAGING_ACCOUNT_CODE
TIGERBEETLE_STAGING_TRANSFER_CODE
TIGERBEETLE_STAGING_DEBIT_ACCOUNT_ID
TIGERBEETLE_STAGING_CREDIT_ACCOUNT_ID
```

The cluster ID must be a nonzero decimal or `0x`-prefixed unsigned 128-bit identifier. The debit and credit accounts must be distinct and provisioned for the approved test. TLS is required for non-loopback staging. The cluster endpoint, ordered replica addresses, binary digest, quorum state, and transport verification belong in the E-04 evidence bundle.

### 4. Run the approved E-04 load and primitive checks

The committed workflow requires an immutable payment-engine image digest and bounded test inputs:

```bash
export IMAGE_DIGEST=sha256:<64-lowercase-hex-digest>

gh workflow run staging-tigerbeetle-loadtest.yml \
  --repo munisp/UmojaFlowOS \
  --ref "$RELEASE_SHA" \
  -f image_digest="$IMAGE_DIGEST" \
  -f duration_seconds=60 \
  -f workers=4 \
  -f batch_size=256

gh run watch --repo munisp/UmojaFlowOS
```

The workflow builds the Go load-test command, requires the staging approval marker, constructs the official TigerBeetle client, creates batched transfers, checks returned statuses, and uploads a JSON report. The report must show zero unexpected failures and a nonzero transfer count. A failed or absent report leaves E-04 open.

### 5. Run the PostgreSQL/TigerBeetle reconciliation

Run from a protected staging runner with the read-only/audit database role and a secret-backed TLS URL:

```bash
export AUDIT_DATABASE_URL="$(secret_ref staging/umoja/reconciliation-postgres-url)"
export RECONCILIATION_SOURCE_IDENTITY="staging-reconciliation-runner/${RUN_ID}"
export WINDOW_START="2026-08-26T00:00:00Z"
export WINDOW_END="2026-08-27T00:00:00Z"
export RUN_REFERENCE="${RUN_ID}"
export RECONCILIATION_METRICS_PATH="$EVIDENCE_DIR/reconciliation/reconciliation.prom"

AUDIT_DATABASE_URL="$AUDIT_DATABASE_URL" \
RECONCILIATION_SOURCE_IDENTITY="$RECONCILIATION_SOURCE_IDENTITY" \
WINDOW_START="$WINDOW_START" \
WINDOW_END="$WINDOW_END" \
RUN_REFERENCE="$RUN_REFERENCE" \
RECONCILIATION_METRICS_PATH="$RECONCILIATION_METRICS_PATH" \
  scripts/infra/reconcile_tigerbeetle_postgres.sh \
  > "$EVIDENCE_DIR/reconciliation/reconciliation.stdout" \
  2> "$EVIDENCE_DIR/reconciliation/reconciliation.stderr"
```

The wrapper requires `sslmode=verify-full` unless an explicit loopback-only development exception is used. It invokes the transactional SQL comparison and records a run in `ledger_reconciliation_runs`. The SQL compares approved/posted intents with projected TigerBeetle facts by transfer ID where available and by the complete correlation/currency/amount/debit/credit key otherwise.

The accepted success output is:

```text
reconciliation_status=reconciled
```

The persisted run must have `status = 'reconciled'` and `discrepancy_count = 0`. A `missing_fact`, `unexpected_fact`, or `field_mismatch` produces `reconciliation_status=discrepancy`, a nonzero exit, discrepancy rows, and a failed E-04 evidence item. A database timeout, connection loss, transaction failure, missing run row, or ambiguous status produces `reconciliation_status=indeterminate`; payment execution must remain stopped until the run is investigated.

After the run, capture only non-secret database evidence:

```bash
psql "$AUDIT_DATABASE_URL" -X -At -v ON_ERROR_STOP=1 \
  -v run_reference="$RUN_REFERENCE" \
  -c "SELECT run_reference, status, intent_count, fact_count, discrepancy_count, source_identity, completed_at FROM ledger_reconciliation_runs WHERE run_reference = :'run_reference'" \
  > "$EVIDENCE_DIR/reconciliation/run-summary.txt"

sha256sum "$EVIDENCE_DIR"/reconciliation/* \
  > "$EVIDENCE_DIR/reconciliation/SHA256SUMS"
```

The reconciliation metrics file may be scraped by Prometheus. It exposes one-hot `reconciled`, `discrepancy`, and `indeterminate` status gauges, the last discrepancy count, and the last run timestamp. Any `discrepancy` or stale `indeterminate` alert requires an incident record and blocks release approval.

### 6. Optional approved failover rehearsal

Use plan mode first:

```bash
TIGERBEETLE_DR_TARGET=staging \
  scripts/infra/tigerbeetle_dr_failover.sh plan
```

Execution requires the approved failover marker and cluster-specific reviewed hooks for freeze, fence, quorum verification, promotion, in-flight reconciliation, PostgreSQL/TigerBeetle reconciliation, and resume. Capture the quorum transition, recovery time, reconciliation output, alert delivery, and cleanup. An indeterminate recovery state is a hard release blocker.

## Current local validation limitation

The reconciliation regression suite is present and its shell syntax check passes, but the local environment currently skips the three PostgreSQL-backed tests because no approved local PostgreSQL fixture is available. That is not staging evidence. The above commands must run in the controlled staging environment with real schema, projected ledger facts, protected credentials, and approved operators.

## References

[1]: /home/ubuntu/UmojaFlowOS/scripts/infra/verify_production_release_evidence.py "Fail-closed release evidence verifier"
[2]: /home/ubuntu/UmojaFlowOS/scripts/infra/reconcile_tigerbeetle_postgres.sh "PostgreSQL/TigerBeetle reconciliation wrapper"
[3]: /home/ubuntu/UmojaFlowOS/scripts/infra/reconcile_tigerbeetle_postgres.sql "Transactional reconciliation comparison"
[4]: /home/ubuntu/UmojaFlowOS/.github/workflows/staging-tigerbeetle-loadtest.yml "E-04 staging load-test workflow"
[5]: /home/ubuntu/UmojaFlowOS/assurance/release_evidence_manifest.schema.json "Release manifest schema"
