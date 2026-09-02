# UmojaFlowOS External Sign-Off Compliance Audit Checklist

**Status:** Working checklist — complete only against an authorized staging release  
**Scope:** E-01–E-09 evidence and four independent approval roles  
**Rule:** Local, synthetic, simulated, or static evidence must not be represented as live regulatory evidence.

## A. Release identity and evidence-control preflight

- [ ] Confirm the release is one immutable Git commit with no uncommitted or untracked implementation, configuration, migration, or dependency changes.
- [ ] Record the full 40-character `release_sha` in every E-01–E-09 artifact and each approval object.
- [ ] Confirm the staging environment identifier and deployment run ID.
- [ ] Generate an artifact inventory with exact paths, sizes, MIME types, creation times, and SHA-256 digests.
- [ ] Store evidence in an access-controlled immutable/WORM location.
- [ ] Verify that logs contain no passwords, tokens, private keys, customer secrets, or raw sensitive identity documents.
- [ ] Record verifier version, schema version, command lines, toolchain versions, and UTC timestamps.
- [ ] Confirm every skipped test has a completed disposition record and that no accepted exception hides a P0 control failure.

## B. E-01–E-09 evidence checklist

| ID | Evidence item | Required checks | Minimum acceptance evidence | Primary accountable role |
|---|---|---|---|---|
| E-01 | Immutable release and provenance | Reviewed commit; signed/tagged release; clean worktree; SBOM/provenance; source-to-artifact mapping. | Commit SHA, signed tag or equivalent, review record, build run ID, image/artifact digests, SBOM, provenance attestation. | Release Manager |
| E-02 | Staging migration and schema state | Fresh migration replay; migration version; canonical schema validation; application/schema-owner separation. | Migration log; migration checksum list; `validate_schema.sql` output; role/grant output; deployed database identity. | Operations Owner |
| E-03 | Real PostgreSQL integration | Database-gated suites execute without silent skips; idempotency, lease, reconciliation, and RBAC paths pass. | Test report; database URL redacted; role identity attestation; correlation IDs; failure-path records; no unexplained failures. | Operations Owner + Compliance Owner |
| E-04 | TigerBeetle/ledger staging | Cluster identity/quorum; account bindings; transfer idempotency; reconciliation; consensus-loss fencing; rollback/recovery. | Cluster attestation; transfer and reconciliation reports; zero unexplained discrepancies; incident/recovery record; independent review. | Operations Owner + Compliance Owner |
| E-05 | Provider, identity, AML, and regulatory integrations | Keycloak issuer/JWKS/audience/roles; Vault; provider webhooks/HMAC; AML/CFT/CPF screening; regulatory endpoint; secret resolution; revocation/TTL. | Signed request/response traces; provider authorization; screening cases; endpoint receipts; token and secret-rotation evidence; no secret leakage. | Compliance Owner + Security Owner |
| E-06 | Deployment, rollback, and health gate | Immutable image digest; rollout; health checks; failure injection; rollback; post-rollback reconciliation and customer-harm controls. | Deployment record; image digest; SBOM/provenance; health output; incident timeline; rollback record; post-rollback state verification. | Release Manager + Operations Owner |
| E-07 | Observability and paging | Prometheus targets; rule evaluation; Alertmanager routing; non-production PagerDuty/Slack delivery; Grafana live series; retention. | Target-up evidence; `promtool`/`amtool` output; receiver event IDs; dashboard capture/data export; alert acknowledgement and runbook link. | Operations Owner + Security Owner |
| E-08 | Resilience, chaos, DR, and recovery | Network/provider/HSM/ledger faults; detection; containment; failover; reconciliation; restore; RTO/RPO; cleanup; evidence retention. | Chaos/DR run ID; injected-fault scope; detection and recovery timestamps; reconciliation result; RTO/RPO; CAP items; independent witness. | Operations Owner + Security Owner |
| E-09 | Independent security and release review | SBOM; dependency audit; secret scan; threat/security review; manifest integrity; approval binding; unresolved findings. | Security report; zero-unresolved-critical/high policy result or approved exception; SHA-bound manifest; signed security approval; verifier output. | Security Owner |

## C. Four independent approval reviews

### Release Manager

- [ ] Confirm E-01–E-09 are present, complete, and all artifact digests match.
- [ ] Confirm the package references one immutable `release_sha`.
- [ ] Confirm build, deployment, rollback, and release-provenance records correspond to that SHA.
- [ ] Confirm no unreviewed file is included in the release.
- [ ] Record a distinct verified directory/certificate subject and UTC approval time.

### Security Owner

- [ ] Review threat model, security findings, dependency/SBOM results, secret scan, mTLS, HSM, Keycloak/Vault, WORM, and zero-trust controls.
- [ ] Confirm all critical/high findings are closed or explicitly accepted by the authorized governance process.
- [ ] Confirm signatures/certificates are valid, trusted, unexpired, and not revoked.
- [ ] Confirm security approval references the exact manifest and release SHA.
- [ ] Record conflicts, recusals, and any residual risk.

### Compliance Owner

- [ ] Review KYC/KYB, AML/CFT/CPF, sanctions, Travel Rule, SoD, consumer safeguards, regulatory reporting, and dossier boundaries.
- [ ] Confirm synthetic data is not being used as legal, customer, or regulatory evidence.
- [ ] Confirm provider permissions, MLRO operation, escalation, retention, and SAR/STR decision evidence.
- [ ] Confirm every skipped test has a defensible disposition and no regulatory-critical skip is misclassified as passed.
- [ ] Confirm the controlled-live perimeter and CBN authorization boundary.

### Operations Owner

- [ ] Review staging topology, startup validation, migration state, capacity, pool sizing, resource limits, health gates, alert delivery, on-call coverage, and incident response.
- [ ] Confirm backup/restore, DR, failover, rollback, reconciliation, and cleanup evidence.
- [ ] Confirm production secrets were not exposed to logs or local workspaces.
- [ ] Confirm operational runbooks are versioned and linked from alerts.
- [ ] Record a distinct verified directory/certificate subject and UTC approval time.

## D. Manifest and approval validation

- [ ] Root `release_sha` matches the immutable release revision.
- [ ] `environment` is `staging` or `production` as authorized.
- [ ] `created_at` is a valid UTC/RFC 3339 timestamp.
- [ ] At least nine artifact entries exist and cover E-01 through E-09.
- [ ] Every artifact path exists in immutable storage.
- [ ] Every artifact SHA-256 is 64 lowercase hexadecimal characters and verifies.
- [ ] Every artifact has a non-empty run ID.
- [ ] Exactly one approval exists for each role: release manager, security owner, compliance owner, operations owner.
- [ ] Approval subjects are verified and distinct.
- [ ] Approval subjects are not duplicated across roles or conflicted/recused for the decision.
- [ ] Every approval references the same release SHA.
- [ ] Approval timestamps are valid UTC/RFC 3339 values and occur after evidence completion.
- [ ] Digital signatures or trusted certificate references cover the canonical manifest or its digest.
- [ ] Any sidecar evidence is itself hashed, retained, and bound to the manifest.

## E. Final decision

- [ ] **GO:** All P0 conditions are closed, all material E-01–E-09 evidence passes, no unexplained discrepancies remain, the verifier passes, and all four independent approvals are valid.
- [ ] **NO-GO:** Any missing P0 evidence, unresolved critical/high security issue, unknown ledger outcome, WORM-integrity failure, provider/AML failure, inability to suspend the pilot, invalid digest/signature, duplicate approval subject, or unapproved regulatory boundary.

A completed checklist demonstrates eligibility for the next authorized review gate. It does not itself grant a CBN licence or unrestricted authority to operate.
