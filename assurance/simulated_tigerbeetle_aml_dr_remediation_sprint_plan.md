# Simulated Remediation Sprint Plan

## TigerBeetle, AML/CFT/CPF, and Disaster-Recovery Evidence

**Planning status:** Simulation for external-audit preparation  
**Duration:** 10 business days, followed by a two-day independent reassessment  
**Target:** Close the open evidence gaps corresponding primarily to E-04, E-05, E-06, and E-08  
**Decision boundary:** This plan does not create regulatory evidence and does not authorize live funds movement, customer activity, or regulatory submission.

## Executive objective

The sprint is designed to convert three categories of “not proven” evidence into independently reviewable staging evidence. The work must run against one immutable release SHA in a segregated staging environment using approved credentials, synthetic or authorized test subjects, controlled transaction limits, and immutable evidence retention. Any unknown ledger outcome, screening-provider outage, reconciliation discrepancy, inability to suspend activity, WORM-integrity failure, or missing approval stops the sprint and leaves the release **NO-GO**.

The target outcome is not unrestricted production authorization. A successful sprint produces a reassessment-ready evidence package for authorized review and, if accepted by the relevant authorities, eligibility to proceed to the next CBN Sandbox gate.

## Open-gap mapping

| Gap | Existing position | Sprint workstream | Primary evidence target |
|---|---|---|---|
| TigerBeetle live/staging behavior | Code and local tests exist; real cluster, quorum, account binding, reconciliation, and recovery are not attested. | TB-01 through TB-07 | E-04 and supporting E-06/E-08 records. |
| AML/CFT/CPF and provider operation | Screening, sanctions, case, and regulatory controls are modeled; real provider responses, failure paths, and MLRO evidence are not attested. | AML-01 through AML-07 | E-05 and supporting E-07/E-08 records. |
| DR, restore, and operational recovery | Runbooks and scripts exist; no approved restore, failover, RTO/RPO, reconciliation, or independent witness evidence is retained. | DR-01 through DR-07 | E-06 and E-08. |

## Governance and responsibilities

| Role | Sprint responsibility | Required independence |
|---|---|---|
| Release Manager | Freezes the release SHA, controls evidence inventory, and coordinates the final manifest. | Cannot unilaterally approve security, compliance, and operations evidence. |
| Security Owner | Reviews identities, mTLS, secrets, HSM/signing, WORM integrity, threat controls, and evidence redaction. | Must independently review security evidence and detached signature. |
| Compliance Owner / MLRO | Owns AML/CFT/CPF cases, sanctions dispositions, Travel Rule evidence, consumer safeguards, and regulatory boundaries. | Must independently review compliance outcomes and recusal records. |
| Operations Owner | Owns staging topology, TigerBeetle operations, deployment, monitoring, failover, restore, and on-call readiness. | Must independently review operational evidence and recovery times. |
| Treasury/Ledger Witness | Verifies account bindings, posting intents, reconciliations, balances, and discrepancies. | Must not be the sole executor and approver of financial tests. |
| Independent Reviewer | Performs the two-day reassessment and verifies evidence hashes, run IDs, timestamps, and exceptions. | Must not have generated the evidence package. |

## Sprint prerequisites and entry gate

The sprint may start only after the Release Manager records the immutable release SHA and a clean-worktree/build attestation. Operations must provision an isolated staging namespace, PostgreSQL, Redis, Keycloak, Vault, WORM/object-lock storage, monitoring, the TigerBeetle cluster, provider sandboxes, and the approved AML/sanctions test endpoints. Compliance must approve the test subjects, transaction corridors, screening fixtures, retention period, and controlled-live limits. Security must approve secret delivery, mTLS, HSM/test signing, network boundaries, and log-redaction checks.

The entry gate fails closed if any credential is missing, a provider endpoint is not authorized, the environment cannot be isolated from customers, test limits cannot be technically enforced, or evidence cannot be written to immutable storage.

## Day-by-day execution plan

| Day | TigerBeetle track | AML/CFT/CPF track | DR/operations track | Exit evidence |
|---:|---|---|---|---|
| 1 | Verify cluster identity, version, quorum, namespace, node inventory, and account-binding plan. | Approve risk-based test matrix, test subjects, sanctions fixtures, MLRO roles, and provider entitlements. | Freeze SHA; verify staging inventory, backups, monitoring targets, WORM bucket, and recovery contacts. | Signed entry checklist and environment attestation. |
| 2 | Create or verify segregated test accounts; confirm debit/credit ownership and idempotency keys. | Execute clear, hit, false-positive, high-risk, and unavailable-provider screening cases. | Capture baseline backups, database/TigerBeetle snapshots where permitted, queue depths, health, and SLO baselines. | TB account map; AML case seed and baseline snapshot. |
| 3 | Execute batch transfers, duplicate submissions, retry, timeout, and payload-binding tests. | Verify analyst assignment, escalation, disposition, audit trail, retention, and dual-control approval. | Run deployment health gate and controlled service restart; verify alerting and evidence capture. | Transfer report; case lifecycle report; health-gate output. |
| 4 | Inject provider/network delay and TigerBeetle client failure; verify no accidental settlement. | Exercise webhook HMAC, replay, malformed response, timeout, and provider-unavailable behavior. | Conduct first failover drill; record detection, containment, failover, and recovery timestamps. | Failure-path traces; first incident timeline. |
| 5 | Run PostgreSQL-to-ledger reconciliation and investigate every mismatch; do not suppress differences. | Execute sanctions escalation and high-risk disposition; validate SAR/STR decision workflow without fabricating a filing receipt. | Perform controlled rollback and post-rollback reconciliation; verify customer-impact suspension. | Mid-sprint review; discrepancy register; rollback record. |
| 6 | Test lease loss, consensus-loss fencing, restart recovery, and read-only/hold behavior. | Verify Travel Rule fields, counterparty data minimization, retention, and access visibility. | Execute backup restore to isolated recovery environment; measure RTO/RPO and validate schema/migrations. | TB recovery evidence; AML privacy/retention evidence; restore report. |
| 7 | Repeat critical transfers under concurrency and verify single settlement per idempotency key. | Replay complete case traces independently; confirm no analyst or approver conflict and record recusals. | Execute second DR/failover scenario with monitoring and escalation routed to non-production receivers. | Independent replay output; second incident timeline; alert receipts. |
| 8 | Complete ledger reconciliation, zero-unexplained-difference sign-off, and account/balance evidence. | Run provider failover or alternate approved provider path; verify fail-closed behavior when both rails are unavailable. | Run cleanup, evidence retention, WORM immutability, and restore-integrity checks. | Final test outputs and immutable object inventory. |
| 9 | Package E-04 records and cross-reference E-06/E-08 incident and recovery records. | Package E-05 screening, identity, webhook, regulatory-channel, and MLRO records. | Package deployment, rollback, monitoring, DR, RTO/RPO, and CAP records. | Draft E-04/E-05/E-06/E-08 evidence bundle. |
| 10 | Treasury/Ledger Witness performs independent reconciliation review. | Compliance Owner/MLRO performs independent case and sanctions review. | Security and Operations perform manifest, redaction, WORM, and signature preflight. | Evidence freeze and exception register. |

## TigerBeetle acceptance criteria

The TigerBeetle track closes only if the cluster ID, version, quorum, and account bindings are recorded; every test transfer has a unique idempotency identity; duplicate and retry attempts cannot create duplicate settlement; UNKNOWN, lease-loss, timeout, and consensus-loss conditions remain held or fail closed; PostgreSQL and TigerBeetle reconcile with zero unexplained differences; restart/failover recovery is successful; and the Treasury/Ledger Witness signs the reconciliation report.

A single unexplained discrepancy, ambiguous transfer identity, missing cluster attestation, or successful settlement after an unresolved UNKNOWN state is a hard stop. The required evidence set includes command output, cluster metadata, transfer IDs, request/correlation IDs, before/after balances where permitted, reconciliation output, incident records, and SHA-256 digests.

## AML/CFT/CPF acceptance criteria

The AML track closes only if clear, true-hit, false-positive, high-risk, timeout, unavailable-provider, malformed-response, replay, escalation, and disposition scenarios are executed with authorized staging providers. Each case must identify the source/provider and version, subject or test identifier, analyst, timestamps, rules/model version, decision rationale, escalation route, retention result, and independent review.

The MLRO must confirm that the platform does not fabricate a SAR/STR filing receipt. Where the external reporting channel is unavailable, the evidence must show a held draft, escalation, retry/reconciliation procedure, and explicit NO-GO treatment for submission claims. Any screening outage that permits an unreviewed high-risk transaction to proceed is a hard stop.

## DR and operational acceptance criteria

The DR track closes only if a controlled deployment failure, service/provider fault, database restore, ledger recovery, and rollback are exercised in segregated staging. The records must show the fault injected, detection time, alert route, containment action, decision authority, recovery time, reconciliation result, data-integrity result, cleanup, and post-exercise corrective actions. RTO and RPO must be measured rather than stated as targets only.

Restore evidence must prove that the recovered database uses the expected migration state, application/schema-owner separation, and release-compatible schema. WORM/object-lock evidence must show that the retained records cannot be altered or deleted by the publishing identity. Any inability to suspend activity, restore consistently, reconcile after recovery, or preserve immutable evidence is a hard stop.

## Evidence package structure

```text
evidence/<release_sha>/
  E-04-tigerbeetle/
    cluster-attestation.json
    account-bindings.json
    transfer-idempotency.json
    failure-closed-and-recovery.json
    reconciliation.json
  E-05-aml-provider/
    provider-authorization.json
    screening-case-matrix.json
    webhook-and-replay.json
    mlro-review.json
    regulatory-channel-result.json
  E-06-deployment-rollback/
    rollout.json
    health-gate.json
    rollback.json
    post-rollback-reconciliation.json
  E-08-resilience-dr/
    fault-injection.json
    failover-timeline.json
    restore-rto-rpo.json
    recovery-reconciliation.json
    corrective-action-plan.json
  manifest.json
  signatures/
    release_manager.json
    security_owner.json
    compliance_owner.json
    operations_owner.json
```

Every file must include the release SHA, environment identifier, run ID, UTC timestamps, responsible operator, reviewer where applicable, and SHA-256 digest. Sensitive fields must be redacted or represented by approved references; raw credentials and private keys must never enter the evidence bundle.

## Formal stop conditions

The sprint immediately stops and reverts to **NO-GO** when a ledger result is UNKNOWN and cannot be reconciled, a transfer settles after a fail-closed decision, a screening or regulatory provider outage bypasses review, a high-risk alert is incorrectly cleared, a restore produces inconsistent records, a critical alert is not delivered, WORM evidence is mutable, a release SHA or artifact digest changes after evidence capture, an approval subject is duplicated or unverified, or test activity escapes the approved perimeter.

A stop condition creates an incident record, freezes affected evidence, preserves logs, blocks retries that could cause duplicate settlement, notifies the relevant owner, and opens a corrective-action item. The sprint does not continue by replacing a failed result with synthetic success.

## Independent reassessment gate

On Days 11–12, the Independent Reviewer verifies that every E-04, E-05, E-06, and E-08 artifact exists, is non-empty, has a matching digest, references the same release SHA, and is retained immutably. The reviewer checks that the test run IDs resolve to the authorized environment, that evidence timestamps are internally consistent, that discrepancies and incidents are closed or explicitly accepted, and that all compensating controls have expiry dates.

The Release Manager then prepares the complete E-01–E-09 manifest. The four required roles independently review the same frozen bundle: `release_manager`, `security_owner`, `compliance_owner`, and `operations_owner`. Each role must have one verified, distinct subject, the same release SHA, a UTC approval timestamp, and a detached Ed25519 signature over the canonical manifest binding.

## Sprint exit decision

| Exit state | Criteria | Regulatory effect |
|---|---|---|
| **Closed for reassessment** | All acceptance criteria pass, no hard-stop exception remains, evidence is immutable and SHA-bound, and four independent approvals are valid. | Eligible for authorized external/CBN reassessment; not unrestricted production authorization. |
| **Conditional extension** | Non-critical evidence gap remains with owner, compensating control, expiry, and authorized acceptance. | Remains NO-GO for any affected live capability; extension must be documented. |
| **Failed / NO-GO** | Any hard-stop condition, unexplained financial discrepancy, failed AML control, failed restore/reconciliation, invalid digest/signature, or missing required approval. | No live activation; corrective-action sprint required. |

## Planned deliverables

The sprint should produce an immutable evidence bundle, a completed exception and compensating-control register, TigerBeetle reconciliation and recovery report, AML/CFT/CPF case and provider report, deployment/rollback report, DR/restore RTO/RPO report, monitoring/alert receipts, CAP tracker, release manifest, four detached approval sidecars, and an independent reassessment memorandum.

## Reference basis

This simulated plan is aligned to the repository’s `requirements_traceability.md`, `production_approval_and_financial_reconciliation_runbook.md`, `staging_evidence_collection_and_signoff_runbook.md`, `release_evidence_manifest.schema.json`, and the current production-readiness scorecard. Those materials establish that local tests and static configurations are not substitutes for authorized staging evidence.
