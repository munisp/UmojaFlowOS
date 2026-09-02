# UmojaFlowOS E-01–E-09 Evidence Completion Template

**Status:** DRAFT / READY FOR AUTHORIZED STAGING / COMPLETE / NO-GO  
**Environment:**  ￼  
**Release SHA (40 lowercase hex):**  
**Reconciliation run ID:**  
**Evidence bundle URI:**  
**WORM bucket/object-lock binding:**  
**Created at (UTC):**  
**Verifier version:**  
**Schema version:**  

> This template must be completed against an authorized staging or production release. Local, synthetic, simulated, or static evidence must not be represented as live regulatory evidence.

## 1. Release-control preflight

| Check | Evidence/reference | Owner | Status |
|---|---|---|---|
| One immutable reviewed commit |  | Release Manager | ☐ |
| Release SHA appears in every E-01–E-09 artifact |  | Release Manager | ☐ |
| Artifact inventory includes path, size, MIME type, timestamp, SHA-256 |  | Operations Owner | ☐ |
| Evidence stored in access-controlled WORM storage |  | Operations Owner | ☐ |
| Secrets and sensitive customer data absent from logs |  | Security Owner | ☐ |
| Toolchain, verifier, schema, and command versions recorded |  | Release Manager | ☐ |
| All skipped tests have signed dispositions |  | Compliance Owner | ☐ |

## 2. E-01–E-09 evidence register

| ID | Evidence item | Required live artifact paths | Required acceptance result | Run ID | SHA-256 | Owner | Status |
|---|---|---|---|---|---|---|---|
| E-01 | Immutable release and provenance | Commit/tag review, SBOM, provenance, build record, image digest | Source-to-artifact mapping is complete and digest-bound |  |  | Release Manager | ☐ |
| E-02 | Staging migration and schema state | Migration log, checksum list, schema validation, grants/role output | Fresh replay passes; app role has no DDL privileges |  |  | Operations Owner | ☐ |
| E-03 | Real PostgreSQL integration | Database-gated test report and failure-path evidence | No silent skips; idempotency, lease, reconciliation, and RBAC tests pass |  |  | Operations + Compliance | ☐ |
| E-04 | TigerBeetle/ledger staging | Cluster/quorum, transfer, reconciliation, consensus-loss and recovery evidence | No unexplained discrepancies; fencing and recovery verified |  |  | Operations + Compliance | ☐ |
| E-05 | Provider, identity, AML, and regulatory integrations | Keycloak/Vault/provider/AML/regulatory traces and rotation evidence | Authorization, screening, webhook, revocation, and secret controls pass |  |  | Compliance + Security | ☐ |
| E-06 | Deployment, rollback, and health gate | Deployment, digest, health, failure-injection, rollback, reconciliation records | Immutable image and successful rollback/post-rollback verification |  |  | Release + Operations | ☐ |
| E-07 | Observability and paging | Target-up, promtool/amtool, receiver IDs, dashboard and retention evidence | Alerts route correctly and tenant-safe telemetry is visible |  |  | Operations + Security | ☐ |
| E-08 | Resilience, chaos, DR, and recovery | Chaos/DR run, injected fault, timestamps, RTO/RPO, reconciliation, CAP | Detection, containment, failover, restore, and cleanup meet SLO |  |  | Operations + Security | ☐ |
| E-09 | Independent security and release review | SBOM, dependency audit, secret scan, threat review, signature output | No unresolved critical/high findings or approved exception; signatures valid |  |  | Security Owner | ☐ |

## 3. Artifact-level validation

For each artifact, record:

```text
Artifact path:
Evidence ID:
Release SHA:
Reconciliation run ID:
SHA-256:
MIME type:
Creation time (UTC):
Source command/tool:
Live environment:
Validator result:
Validator version:
Reviewer:
Reviewer timestamp:
Exceptions/CAP:
WORM object URI:
Object-lock mode:
Retain-until timestamp:
Legal hold:
```

## 4. Four-role approvals

| Role | Subject | Certificate/key ID | Manifest SHA | Approval time UTC | Conflict/recusal check | Signature verified | Status |
|---|---|---|---|---|---|---|---|
| Release Manager |  |  |  |  | ☐ | ☐ | ☐ |
| Security Owner |  |  |  |  | ☐ | ☐ | ☐ |
| Compliance Owner |  |  |  |  | ☐ | ☐ | ☐ |
| Operations Owner |  |  |  |  | ☐ | ☐ | ☐ |

Each approval must bind to the same release SHA and canonical manifest. Subjects must be distinct, authorized, unexpired, and not recused.

## 5. Exceptions and skipped tests

| Test/control | Disposition | Compensating control | Risk owner | Expiry UTC | Approval | P0 impact |
|---|---|---|---|---|---|---|
|  |  |  |  |  |  |  |

No exception may conceal an unresolved P0 control failure, unknown ledger outcome, invalid signature, provider/AML failure, WORM failure, or inability to suspend the pilot.

## 6. Final decision

### GO prerequisites

- ☐ All 14 required live evidence files are present.
- ☐ E-01 through E-09 artifacts are complete, hashed, and retained immutably.
- ☐ Artifact-specific validators pass.
- ☐ Manifest schema and WORM/reconciliation bindings pass.
- ☐ Four distinct approval roles are present and cryptographically verified.
- ☐ Image digest, signature, and provenance checks pass.
- ☐ No unresolved P0 or unapproved critical/high issue remains.
- ☐ No unknown ledger outcome remains unowned.
- ☐ Provider, AML, security, DR, observability, and rollback evidence pass.

**Decision:** GO / NO-GO  
**Decision timestamp UTC:**  
**Decision authority:**  
**Reason:**  
**Next review/expiry:**  
