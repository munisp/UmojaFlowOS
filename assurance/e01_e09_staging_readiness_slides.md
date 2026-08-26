# UmojaFlowOS E-01–E-09 Staging Readiness

**Release under review:** `ad2722423a58d7e2d2ba883fb58d737159c51365`

**Run posture:** Local validation and contract checks only; real staging evidence remains fail-closed.

**Generated:** 2026-08-26

---

## Slide 1 — Executive release posture

> **Production decision: NO-GO pending controlled staging evidence and independent approvals.**

The repository is at the reviewed `origin/main` revision `ad2722423a58d7e2d2ba883fb58d737159c51365`. The current E-01–E-09 harness completed its local checks, but it did not invent signed release artifacts, external-provider results, cluster results, deployment receipts, or recovery evidence.

| Readiness category | Count | Interpretation |
|---|---:|---|
| Blocked | 5 | Real staging prerequisite or evidence bundle is missing |
| Local Pass | 2 | Local implementation test passed; staging proof still required |
| Local Contract Pass | 2 | Local validator/contract passed; live delivery or staging proof still required |
| **Total** | **9** | **No category alone authorizes production** |

---

## Slide 2 — E-01 through E-09 status map

| Evidence item | Current status | Evidence interpretation |
|---|---|---|
| E-01 | **BLOCKED** | No signed staging tag, provenance, SBOM, or immutable image-digest bundle supplied |
| E-02 | **BLOCKED** | Local database schema drift; staging migration and reconciliation-column proof not supplied |
| E-03 | **LOCAL PASS** | PostgreSQL application-role workflow passed locally; controlled staging replay remains required |
| E-04 | **BLOCKED** | No approved staging TigerBeetle endpoint, cluster/account values, or DR window supplied |
| E-05 | **LOCAL CONTRACT PASS / STAGING BLOCKED** | Local contracts passed; real Keycloak/provider/AML/regulatory/WORM/notification evidence absent |
| E-06 | **BLOCKED** | No approved staging kubeconfig or immutable staging image digest supplied |
| E-07 | **LOCAL CONTRACT PASS / STAGING BLOCKED** | Local monitoring validators passed; live delivery receipts absent |
| E-08 | **BLOCKED** | No approved backup/restore target, Chaos window, or worker test endpoints supplied |
| E-09 | **LOCAL PASS ONLY** | Secret scan and locked dependency audit passed locally; protected security review absent |

The status source is the fail-closed run output at `assurance/evidence/staging-progress-ad2722423a58d7e2d2ba883fb58d737159c51365/status.tsv`.

---

## Slide 3 — E-01: cryptographic release identity

E-01 requires a chain of evidence, not merely a commit hash:

```text
reviewed commit
    ↓
signed annotated release tag
    ↓
immutable image digest
    ↓
SBOM + SLSA provenance attestation
    ↓
attestation identity and issuer verification
    ↓
provenance payload contains exact source SHA
    ↓
hash-bound evidence manifest
```

The repository-native verifier is:

```bash
scripts/infra/verify_release_cryptography.sh \
  --repo-dir . \
  --release-sha "$RELEASE_SHA" \
  --tag "$RELEASE_TAG" \
  --image "$IMAGE_REPOSITORY@$IMAGE_DIGEST" \
  --certificate-identity-regexp 'approved-release-builder' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  --expected-gpg-fingerprint "$EXPECTED_GPG_FINGERPRINT" \
  --output-dir "$BUNDLE_DIR/cryptography"
```

The verifier exits nonzero for an absent/unsigned tag, SHA mismatch, signer mismatch, mutable image reference, unavailable `cosign`, identity/issuer mismatch, or provenance that does not contain the reviewed SHA.

---

## Slide 4 — E-02: schema migration and reconciliation foundation

E-02 is the database prerequisite for financial reconciliation. The staging operator must apply the canonical migration chain using the advisory-locked runner, then validate schema and privileges:

```bash
export POSTGRES_DATABASE_URL="$(secret_ref staging/umoja/schema-owner-postgres-url)"

POSTGRES_DATABASE_URL="$POSTGRES_DATABASE_URL" \
  scripts/infra/apply_postgres_migrations.sh

psql "$POSTGRES_DATABASE_URL" -X -v ON_ERROR_STOP=1 \
  -f database/postgresql/validate_schema.sql
```

The gate must show a successful checksummed migration ledger and the reconciliation columns, including `ledger_reconciliation_runs.status`, `run_reference`, `intent_count`, `fact_count`, `discrepancy_count`, and `source_identity`, plus `ledger_reconciliation_discrepancies.discrepancy_code`, `expected`, and `observed`.

The current default local database has drift and therefore remains a diagnostic failure, not evidence of a production defect or a staging pass.

---

## Slide 5 — E-04: TigerBeetle and financial reconciliation

E-04 requires a real approved cluster and a completed reconciliation, not only a successful client build.

| Control | Acceptance condition |
|---|---|
| Cluster | Six replicas, identical ordered addresses, nonzero 128-bit cluster ID, independent fault domains |
| Transport | TLS or approved authenticated transport; no remote plaintext exception |
| Ledger | Nonzero NGN ledger, account code, transfer code, and distinct funded debit/credit accounts |
| Primitive test | Batched account/transfer creation, individual result checks, idempotent retry behavior |
| Reconciliation | Every approved/posted intent matched to exactly one projected fact; zero discrepancies |
| Failover | Approved freeze/fence/quorum/promote/reconcile/resume sequence with recovery timings |

Run the reconciliation only after TigerBeetle facts are projected into PostgreSQL:

```bash
export AUDIT_DATABASE_URL="$(secret_ref staging/umoja/reconciliation-postgres-url)"
export RECONCILIATION_SOURCE_IDENTITY="staging-reconciliation-runner/$RUN_ID"
export WINDOW_START='<approved-window-start>'
export WINDOW_END='<approved-window-end>'
export RUN_REFERENCE="$RUN_ID"

AUDIT_DATABASE_URL="$AUDIT_DATABASE_URL" \
RECONCILIATION_SOURCE_IDENTITY="$RECONCILIATION_SOURCE_IDENTITY" \
WINDOW_START="$WINDOW_START" WINDOW_END="$WINDOW_END" \
RUN_REFERENCE="$RUN_REFERENCE" \
  scripts/infra/reconcile_tigerbeetle_postgres.sh
```

Only `reconciliation_status=reconciled` with `discrepancy_count=0` closes the financial reconciliation portion. Missing facts, unexpected facts, field mismatches, timeouts, or indeterminate state block release.

---

## Slide 6 — E-06 and E-08: deployment and recovery gates

**E-06 deployment/rollback** requires an approved staging kubeconfig, image digest, rollout receipt, health checks, and rollback evidence. The deployment must use immutable image references; a mutable tag is insufficient.

**E-08 restore/Chaos/recovery** requires an approved backup/restore target and execution window, fault-injection authorization, recovery timing, RTO/RPO comparison, reconciliation after recovery, alert evidence, and cleanup proof.

The safe sequence is:

```text
immutable build
  → staging deploy
  → health gate
  → controlled fault or restore
  → fence unsafe writes
  → recover
  → reconcile
  → verify alerts
  → capture evidence
  → independent review
```

A failed or indeterminate recovery run leaves both the relevant evidence item and production decision at **NO-GO**.

---

## Slide 7 — Four independent production approvals

The approval array must contain four distinct subjects, each bound to the exact release SHA. Placeholder identities are not approvals.

| Role | Independent responsibility | Current repository status |
|---|---|---|
| Release manager | Source/ref, signed release, provenance, SBOM, image digest, rollback plan | **No real approval present** |
| Security owner | Secrets, mTLS/RBAC, threat model, dependency risk, security evidence | **No real approval present** |
| Compliance owner | AML/CFT/CPF, sanctions, Travel Rule, WORM/legal hold, regulatory evidence | **No real approval present** |
| Operations owner | Deployment, paging, rollback, backup/restore, Chaos, RTO/RPO | **No real approval present** |

Each approval object may contain only:

```json
{
  "role": "release_manager",
  "subject": "distinct-authorized-identity",
  "release_sha": "ad2722423a58d7e2d2ba883fb58d737159c51365",
  "approved_at": "2026-08-26T00:00:00Z"
}
```

The repository contains an approval template, but no tracked populated approval manifest. The four approvals must be created only after the same immutable evidence bundle has been independently reviewed.

---

## Slide 8 — Release-gate execution procedure

```text
1. Freeze the reviewed SHA.
2. Generate and verify signed tag, digest, SBOM, and provenance.
3. Apply and validate staging migrations.
4. Provision/verify TigerBeetle and run E-04 primitives.
5. Project facts and run PostgreSQL/TigerBeetle reconciliation.
6. Deploy immutable images and capture E-06 rollout/rollback evidence.
7. Execute approved restore/Chaos recovery and capture E-08 evidence.
8. Complete E-01–E-09 manifest hashes.
9. Obtain four distinct role approvals.
10. Run the fail-closed release verifier.
11. Permit production only if the verifier exits zero.
```

The final verifier command is:

```bash
python3 scripts/infra/verify_production_release_evidence.py \
  --manifest assurance/evidence/release.json \
  --repo .
```

Any missing artifact, invalid hash, dirty checkout, SHA mismatch, missing role, duplicate subject, malformed timestamp, or external evidence gap produces a nonzero result.

---

## Slide 9 — Current decision and operator handoff

The current run demonstrates repository readiness and local control behavior, but it does **not** demonstrate real staging readiness.

| Decision | Condition |
|---|---|
| Code quality | Local checks available and passing for reviewed paths |
| Evidence readiness | Evidence structure and validators available |
| Staging readiness | **Not demonstrated**; E-01, E-02, E-04, E-06, and E-08 blocked |
| Approval readiness | **Not demonstrated**; all four independent approvals absent |
| Production decision | **NO-GO** |

The next authorized action is to provision the controlled staging inputs, execute the E-01–E-09 commandbook, preserve non-secret evidence, obtain independent approvals, and rerun the immutable verifier. No local dry run can substitute for that evidence.

---

## Appendix — Source artifacts

The deck is grounded in the following repository artifacts:

| Artifact | Purpose |
|---|---|
| `assurance/evidence/staging-progress-ad2722423a58d7e2d2ba883fb58d737159c51365/status.tsv` | Current E-01–E-09 run output |
| `scripts/infra/verify_production_release_evidence.py` | Fail-closed manifest verifier |
| `scripts/infra/verify_release_cryptography.sh` | Signed tag/provenance/image binding verifier |
| `scripts/infra/apply_postgres_migrations.sh` | Locked canonical migration runner |
| `scripts/infra/reconcile_tigerbeetle_postgres.sh` | PostgreSQL/TigerBeetle reconciliation wrapper |
| `.github/workflows/production-release-evidence-gate.yml` | Evidence validation workflow |
| `.github/workflows/staging-tigerbeetle-loadtest.yml` | E-04 staging load-test workflow |
