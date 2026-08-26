# Controlled Staging Evidence Pack: E-01 Through E-09

**Purpose:** This document defines the only acceptable evidence package for requesting a production GO decision. It must be generated against an immutable tagged release in a controlled **staging** environment. Do not substitute local fixtures, simulator responses, placeholder files, screenshots without source data, or manually edited success statements.

> A passing `verify_production_release_evidence.py` result proves that a supplied manifest is structurally complete, hash-consistent, SHA-bound, and independently approved. It does **not** prove that the underlying staging tests were meaningful. Each E-item below therefore has its own source-of-truth and acceptance criteria.

## Preconditions

The release manager must first create a reviewed immutable release candidate. The staging environment must be isolated from production, use non-customer data, have valid time synchronization, and use recipient-owned sandbox endpoints. Secrets must be injected through the approved secret manager and never copied to the evidence archive.

```bash
# On the checked-out, signed release candidate.
git status --porcelain                    # must print nothing
git rev-parse HEAD                        # capture as RELEASE_SHA
make check
make postgres-app-role-integration
(cd apps/control-plane && pnpm audit --prod --json)
```

Create the bundle outside the repository working tree or in an access-controlled release-artifact store:

```bash
export RELEASE_SHA="$(git rev-parse HEAD)"
export RUN_ID="staging-assurance-$(date -u +%Y%m%dT%H%M%SZ)"
export BUNDLE_DIR="/secure-release-evidence/${RELEASE_SHA}/${RUN_ID}"
mkdir -p "$BUNDLE_DIR"/{ci,migrations,ledger,integrations,deployment,observability,resilience,security,approvals}
```

Every resulting artifact must contain its `run_id`, UTC timestamp, environment, release SHA, command/version, and scrubbed correlation identifiers. Store raw confidential logs separately and reference them through approved evidence IDs; never place credentials, private keys, customer records, full webhook payloads, or bearer tokens in this pack.

## E-01 — Immutable source provenance and change review

| Item | Required generation action | Required artifact | Pass criterion |
|---|---|---|---|
| Immutable source | Create an annotated/signed tag from the reviewed commit. | `ci/e01-provenance.txt` and signed-tag verification output. | Tag resolves exactly to `RELEASE_SHA`; worktree is clean. |
| Code review | Use protected branch/PR approval process. | `ci/e01-review.json` exported from the approved review system. | Required independent reviewers approved; no unresolved blocking review. |
| Build provenance and SBOM | Build image(s) from the tag through protected CI. | `ci/e01-provenance.json`, `ci/e01-sbom.spdx.json`, image digest list. | Image digest and source SHA are bound in provenance; SBOM is retained. |

```bash
# Example commands; use the organization-approved signing and CI tools.
git verify-tag "$RELEASE_SHA_TAG"
git rev-list -n 1 "$RELEASE_SHA_TAG"
git status --porcelain
```

## E-02 — Staging migration and schema evidence

| Item | Required generation action | Required artifact | Pass criterion |
|---|---|---|---|
| Migration execution | Run the approved migration job as the staging schema owner. | `migrations/e02-migration-job.log`, migration ledger query output. | Every tracked migration, including `0042`, appears once in the ledger. |
| Canonical schema | Execute schema validation using staged connection with no destructive reset. | `migrations/e02-schema-validation.log`. | `database/postgresql/validate_schema.sql` exits zero. |
| Privilege verification | Run app-role grant checks. | `migrations/e02-grants-check.log`. | Application role can perform only permitted operations; immutable evidence delete is denied. |

```bash
# Use the deployed staging connection from the secret manager; do not echo it.
POSTGRES_DATABASE_URL="$(secret_ref staging/schema-owner-url)" make postgres-check
# Run equivalent application/schema-owner integration job with separate injected URLs.
```

## E-03 — Real PostgreSQL workflow integration

Execute all test files normally skipped by `POSTGRES_INTEGRATION_TEST`, using an isolated staging database and distinct credentials for the application role and fixture schema owner.

| Required evidence | Artifact | Pass criterion |
|---|---|---|
| Role identities and grants (redacted) | `migrations/e03-role-review.json` | Application and schema-owner subjects are distinct; app role has no DDL/audit-delete privilege. |
| Test report | `migrations/e03-postgres-integration.junit.xml` | No required PostgreSQL integration test is skipped or failed. |
| Counterparty workflow | `migrations/e03-counterparty-correlation.json` | Lifecycle, policy decision, outbox, and cleanup evidence share a traceable run ID. |

## E-04 — TigerBeetle ledger and recovery

Use only a designated staging TigerBeetle cluster. Do not point ledger tests at production.

| Required evidence | Artifact | Pass criterion |
|---|---|---|
| Cluster identity and quorum | `ledger/e04-cluster-health.json` | Expected cluster ID, member configuration, and healthy quorum are recorded. |
| Account binding and transfer | `ledger/e04-transfer-results.json` | Test account bindings match expected namespace; duplicate batch/idempotency request creates no duplicate posting. |
| Reconciliation | `ledger/e04-reconciliation.json` | Reconciliation returns no unexplained fact/intention discrepancy. |
| Consensus-loss recovery | `ledger/e04-failover-drill.json` | Transaction path fences during indeterminate state; recovery and reconciliation complete before resumption. |

Run the reviewed staging commands from the release candidate, including the repository reconciliation and failover scripts. Capture their stdout/stderr, metrics snapshot, and run correlation ID.

## E-05 — Identity, AML/CFT, webhook, regulatory, WORM, and notification dependencies

| Dependency | Required success evidence | Required refusal/failure evidence |
|---|---|---|
| Keycloak OIDC | Issuer, JWKS, audience, and client redirect contract passes. | Wrong audience/key/issuer is denied. |
| AML/CFT | Staging screening request/response with provider correlation ID. | Timeout/indeterminate response blocks execution and records reason. |
| Provider webhooks | Valid HMAC, timestamp, CIDR, and idempotency receipt. | Bad signature, stale timestamp, replay, and wrong source are rejected. |
| Regulatory endpoint | Recipient-owned sandbox receipt and request digest. | Non-success/retry path remains non-executing and auditable. |
| WORM/Object Lock | Object version, retain-until, legal-hold, digest, and detached signature check. | Missing/incomplete/unverified archive blocks deletion. |
| Notification | Test PagerDuty/Slack/approved receiver event ID. | Receiver failure records a retry/incident without losing the source evidence. |

Store outputs under `integrations/e05-*.json` and produce a small index file mapping each control to source and recipient correlation IDs.

## E-06 — Deployment and rollback

| Required evidence | Artifact | Pass criterion |
|---|---|---|
| Image and Helm identity | `deployment/e06-image-digests.json`, rendered Helm manifest. | Only immutable image digests are deployed. |
| Rollout | `deployment/e06-rollout.log`. | Health/readiness checks pass on staged workload. |
| Rollback | `deployment/e06-rollback.log`. | A controlled failed health gate rolls back to the expected revision and verifies recovery. |
| Post-rollback checks | `deployment/e06-post-rollback-health.json`. | Service health, auth, and reconciliation gates return expected healthy/refused states. |

## E-07 — Observability and notification delivery

| Required evidence | Artifact | Pass criterion |
|---|---|---|
| Prometheus target discovery | `observability/e07-targets.json`. | Worker and synthetic monitor are `up=1`; expected environment labels are present. |
| Rule evaluation | `observability/e07-rule-query.json`. | Recording and alert rules produce expected series. |
| Alertmanager routing | `observability/e07-route-test.txt` and non-production PagerDuty incident ID. | Circuit and lock-wait routes reach both configured receivers as designed. |
| Grafana | `observability/e07-dashboard-export.json` and screenshot/export. | Dashboard panels contain current real series, not no-data placeholders. |

## E-08 — Resilience, backup, restore, and chaos

| Required evidence | Artifact | Pass criterion |
|---|---|---|
| Backup restore | `resilience/e08-restore-drill.json`. | Restored staging dataset is integrity-checked; measured RTO/RPO satisfy approved objectives. |
| Worker/DB saturation | `resilience/e08-pool-chaos.junit.xml` and report. | Circuit opens fail-closed; no unauthorized delete reaches OpenSearch; recovery probe closes only after dependency health. |
| Monitor path latency | `resilience/e08-monitor-latency.junit.xml`. | Synthetic blindness alert is distinct from worker circuit failure; cleanup completes. |
| TigerBeetle DR | `resilience/e08-ledger-dr.json`. | Fencing, recovery, and reconciliation are successful. |

## E-09 — Security approval

| Required evidence | Artifact | Pass criterion |
|---|---|---|
| Dependency audit | `security/e09-pnpm-audit.json`. | Production dependency audit reports zero advisories from the immutable lockfile. |
| Secret scan | `security/e09-secret-scan.log`. | Secret material validation exits zero. |
| SBOM review | `security/e09-sbom-review.json`. | Security owner records review against exact SHA and image digests. |
| Independent approval | `approvals/e09-security-approval.json`. | Approval subject differs from release manager, compliance owner, and operations owner. |

## Manifest generation and fail-closed verification

Create `release.json` only after all real artifacts exist. Use SHA-256 digests calculated from the stored evidence files. The manifest must list E-01 through E-09 exactly once and four distinct approval subjects.

```bash
python3 scripts/infra/verify_production_release_evidence.py \
  --manifest "$BUNDLE_DIR/release.json" \
  --expected-sha "$RELEASE_SHA"
```

A nonzero result is a mandatory **NO-GO**. A zero result permits an independent review of the bundle; it does not itself authorize production deployment. After all technical evidence passes, collect distinct release-manager, security-owner, compliance-owner, and operations-owner approvals bound to `RELEASE_SHA`.
