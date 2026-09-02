# Simulated External Regulatory Audit — UmojaFlowOS

**Assessment date:** 31 August 2026  
**Assessment type:** Desktop simulation against the generated external sign-off checklist  
**Decision:** **NO-GO for regulatory/live activation; conditional technical GO for exercised local paths**  
**Important limitation:** This is an engineering audit simulation. It is not a CBN decision, legal opinion, independent assurance report, or authorization to operate.

## Executive conclusion

The repository demonstrates substantial implementation and local verification, including clean-room RBAC/SoD evidence, PostgreSQL application/schema-owner separation, fail-closed multi-rail controls, and static monitoring validation. The simulated auditor would not accept the current package as complete E-01–E-09 staging evidence because most evidence is local, synthetic, static, or external-dependency-gated. The package also lacks a production-grade detached-signature set tied to verified human identities.

## E-01–E-09 simulated audit results

| Evidence | Simulated result | Gap identified | Required closure |
|---|---|---|---|
| E-01 | **Not proven** | No complete immutable production candidate, signed release tag, SBOM/provenance chain, and clean-worktree evidence for the final submission revision. | Build and review one immutable commit; generate signed tag, SBOM, provenance, artifact digests, and clean-worktree attestation. |
| E-02 | **Partial** | Fresh local migration replay exists, but deployed staging migration identity, version, checksums, and schema-owner/app-role attestation are not evidenced in the final external package. | Execute against staging; retain migration checksums, schema validation, database identity, and privilege outputs. |
| E-03 | **Partial** | Local PostgreSQL and clean-room compliance tests pass, but the broader database-gated integration set is not demonstrated with no silent skips in staging. | Run all applicable PostgreSQL integration tests with separate identities and retain full output and role evidence. |
| E-04 | **Not proven** | No independently attested TigerBeetle staging cluster, quorum, account binding, transfer, reconciliation, consensus-loss, or recovery evidence. | Execute controlled ledger tests and prove zero unexplained discrepancies and safe rollback/recovery. |
| E-05 | **Not proven** | Keycloak/Vault, provider webhooks, AML/CFT/CPF screening, regulatory delivery, and external endpoint receipts remain unproven or skipped. | Use authorized staging credentials/endpoints; capture signed request/response traces, screening decisions, token/secret lifecycle, and failure-path evidence. |
| E-06 | **Not proven** | Static deployment/rollback controls exist, but no complete immutable-image rollout, health-gate failure, rollback, post-rollback reconciliation, and customer-harm containment record is attached. | Execute the controlled failure and rollback test in staging; bind all records to the release SHA. |
| E-07 | **Partial** | Prometheus and Alertmanager syntax/routing semantics pass locally, but live targets, receiver delivery, PagerDuty/Slack events, and Grafana series are not evidenced. | Run non-production notification tests and retain target, event, acknowledgement, and dashboard evidence. |
| E-08 | **Not proven** | Chaos, DR, restore, and recovery paths are documented but not attested against the target staging topology. | Execute scoped resilience and restore drills; record detection, containment, recovery, RTO/RPO, reconciliation, cleanup, and corrective actions. |
| E-09 | **Partial / incomplete** | Local dependency and security checks exist, but independent security approval, immutable evidence binding, and verified cryptographic signatures are not complete. | Generate the final manifest, verify all digests, obtain independent security review, and validate detached signatures and subjects. |

## Skipped-test impact

The full control-plane run records **149 skipped tests across 28 files**. The skips cover payment workflow, PostgreSQL integration, compliance alerts, provider and service bridges, ledger gateway, KYC lifecycle/adversarial paths, regulatory reporting, VASP readiness, CBN Sandbox integration, treasury, compliance cases, consent, registry authorization, regulatory deadlines, and PostgreSQL role resolution.

A reviewer would treat these as conditional evidence, not passes. Each skip must be marked `executed_pass`, `executed_fail`, `blocked_external_dependency`, `not_applicable`, or `accepted_exception`, with an owner, dependency, evidence path/digest, compensating control, risk rating, approving authority, and expiry/retest date. Regulatory-critical skips cannot be closed by relabeling them as not applicable without an approved product-boundary decision.

## Material audit risks

The simulated audit identifies five material risks. First, local evidence is not equivalent to live staging evidence. Second, the clean-room 44/44 result is narrower than the full 506-passed/149-skipped control-plane result. Third, the pnpm warning indicates that package-level override settings were ignored, creating dependency-reproducibility risk until the supported configuration is used and retested. Fourth, evidence chain-of-custody metadata is incomplete unless command lines, runtime versions, migration checksums, database identity, and immutable storage records accompany the logs. Fifth, the base manifest schema does not encode digital signatures or uniqueness constraints; those must be enforced by the executable verifier and governance process.

## Conditions for simulated audit closure

The simulated auditor would recommend reassessment only after all P0 items are closed, all material E-01–E-09 items are executed or formally accepted by the authorized body, all critical external integrations are attested, no unexplained financial discrepancy remains, the final manifest and sidecars verify against one release SHA, and four independent approvers review the same immutable package.

The four required roles are `release_manager`, `security_owner`, `compliance_owner`, and `operations_owner`. The approvals must have exactly one entry per role, distinct verified subjects, the same release SHA as the manifest, valid UTC timestamps, conflict/recusal clearance, and valid detached cryptographic signatures over the canonical manifest binding.

## Audit opinion

> **Current opinion: adverse for regulatory/live activation, with a conditional technical baseline.** The evidence supports continued controlled engineering and authorized staging work, but not CBN submission finality, unrestricted live operation, custody, customer payment activation, or a claim that all E-01–E-09 requirements have passed.
