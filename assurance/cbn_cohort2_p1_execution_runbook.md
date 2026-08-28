# CBN Cohort 2 VASP P1 Execution Runbook

This runbook executes the repository-verifiable portions of P1 and defines the external staging steps that must remain fail-closed until approved credentials and infrastructure exist.

## Preconditions

Use one immutable candidate SHA and a segregated staging environment. Set `RELEASE_SHA` to the exact 40-character commit under test. Never use the synthetic fixture as CBN evidence.

```bash
cd /home/ubuntu/UmojaFlowOS
export RELEASE_SHA="$(git rev-parse HEAD)"
test "${#RELEASE_SHA}" -eq 40
make check
```

Record:

```bash
git rev-parse HEAD
git status --short
sha256sum assurance/cbn_vasp_application_dossier.schema.json assurance/cbn_vasp_governance.schema.json
```

A non-empty worktree, failed quality gate, missing staging configuration, or unresolved exception stops the run.

## P1-01: Test-control profile

Prepare an approved JSON profile containing product, customer/counterparty population, transaction count/value, per-customer and aggregate exposure, velocity, corridor, asset/currency, start/end time, and suspension triggers. Store it as a release-bound artifact; do not permit participant roles to modify it.

Verify the control plane and negative boundaries with:

```bash
cd /home/ubuntu/UmojaFlowOS/apps/control-plane
pnpm exec vitest run client/src/pages/Home.paymentBoundary.test.ts client/src/components/CbnSandboxWorkspace.boundary.test.ts
cd /home/ubuntu/UmojaFlowOS
python3 scripts/infra/validate_cbn_vasp_application.py \
  --dossier assurance/evidence/approved/dossier.json \
  --governance assurance/evidence/approved/governance.json \
  --repo .
```

Stage acceptance requires server-side rejection for every limit, dual-control approval for changes, immutable audit event, and a configuration digest. UI-only restrictions are insufficient.

## P1-02: Suspension and termination

Use the staging deployment’s approved kill switch or suspension workflow. Exercise screening outage, ledger indeterminacy, reconciliation discrepancy, WORM failure, provider anomaly, and consumer-harm triggers. Confirm no new external movement is accepted after suspension.

Required evidence:

```text
suspension request and correlation ID
state transition before/after
pending-order treatment
provider-disable response
ledger/reconciliation status
customer/counterparty communication
immutable evidence export
recovery or termination decision
```

Acceptance is fail-closed if any pending obligation cannot be reconciled or any customer treatment is unknown.

## P1-03: Incident reporting

Run a timed tabletop and at least one technical exercise covering cyber incident, fraud, data breach, operational failure, regulatory breach, and actual/potential consumer harm. Start the clock at discovery and verify the 24-hour reporting workflow required by the CBN call.

```text
incident_id
severity
found_at
owner and alternate
containment_at
notification decision and recipient
communication record
evidence-hold ID
post-incident review
```

Do not mark an external notification as sent without an attributable official receipt.

## P1-04: Monitoring and notification delivery

Validate rule syntax locally:

```bash
cd /home/ubuntu/UmojaFlowOS
promtool check rules infra/monitoring/keycloak-token-compliance-alerts.yml
promtool check rules infra/monitoring/*.yml
amtool check-config infra/monitoring/alertmanager.yml
```

In staging, verify Prometheus targets for Keycloak, Vault, gateway, PostgreSQL, TigerBeetle, provider adapters, WORM, and workers. Fire a non-production test alert and record Alertmanager routing, PagerDuty/Wazuh receipt, correlation ID, human acknowledgement, and escalation.

Required evidence is E-07. A parsed rule file or a CI log is not live delivery evidence.

## P1-05: TigerBeetle and PostgreSQL reconciliation

Provision the approved staging cluster and verify cluster ID and quorum before sending test transfers. Run the repository’s database/ledger integration targets according to the Makefile and staging runbook. Test:

```text
successful transfer
same idempotency key replay
missing intent
unexpected ledger fact
field mismatch
provider timeout
indeterminate ledger result
replica/network partition
reconciliation after recovery
```

Any indeterminate result blocks payment execution. Required evidence is E-04: cluster identity, account bindings, transfer traces, reconciliation result, fault recovery, and zero unexplained discrepancy.

## P1-06: Deployment rollback and restore

Build the exact release, capture immutable image digest, SBOM and provenance, deploy to staging, run health checks, intentionally fail a controlled rollout, roll back, restore approved backup data, and reconcile payment/evidence state.

```bash
cd /home/ubuntu/UmojaFlowOS
make check
# Use only the protected staging workflow for deployment and rollback.
gh workflow list
gh workflow run staging-release.yml --ref "$RELEASE_SHA"
```

Do not run a production deployment from this runbook. Required E-06 evidence includes image digest, provenance, SBOM, rollout, failure injection, rollback, health, restore, and post-rollback reconciliation.

## P1-07: WORM and audit retention

Verify the deployed WORM-compatible store’s compliance retention, legal hold, detached signature, SHA-256, tamper response, restore, and authorized deletion behavior. Routine secret rotation must never invoke irreversible destroy. Vault cleanup remains plan-only until staging integration tests pass.

```bash
cd /home/ubuntu/UmojaFlowOS
python3 scripts/infra/vault_version_cleanup.py
python3 scripts/infra/vault_version_cleanup.py --apply
```

`--apply` must only be used inside an approved staging window with the separate cleanup identity. Required evidence includes metadata before/after, candidate exclusions, soft-delete response, post-delete verification, hold negative test, and immutable audit record.

## P1-08: Resilience and Chaos

Run only in the approved staging namespace and window. Exercise:

```text
Keycloak/Vault timeout
screening-provider timeout
provider webhook replay/signature failure
TigerBeetle partition/consensus loss
PostgreSQL pool exhaustion
WORM verification failure
retention-worker mTLS failure
Prometheus/Alertmanager/PagerDuty route failure
failed deployment and rollback
```

For each scenario capture injection, detection, containment, alert, state, recovery, reconciliation, RTO/RPO, and residual risk. Required evidence is E-08.

## P1-09: Privacy and data-flow governance

Create a data inventory covering identity, KYC/KYB, transaction, wallet/asset, screening, document, audit, evidence, and telemetry data. Document purpose, minimisation, access, retention, holds/deletion, processors, cross-border transfers, and customer rights. Obtain privacy/legal approval and test retention/hold behavior.

## P1-10: Post-sandbox pathway

Select and document one realistic pathway: existing framework, licence/authorisation application, further supervised development, enhanced supervision, coordinated authority engagement, or discontinuation. Identify CBN and any other competent authority, owners, milestones, and conditions. Sandbox completion does not itself grant a licence or right to operate.

## P1-11: Nigeria-specific impact assessment

Prepare a board-approved analysis of stablecoin and FX exposure, monetary sovereignty, reserves/redemption, liquidity, consumer loss, fraud, concentration, market integrity, competition, inclusion, and systemic spillover. Convert material risks into test limits and suspension triggers.

## P1-12: Independent evidence verification

For each E-01–E-09 artifact, verify:

```text
scope matches approved product/corridor/test population
issuer/owner is named and authorised
artifact is versioned and dated
HTTPS URI resolves to exact artifact
SHA-256 matches
control was actually exercised or document formally approved
submitter and verifier subjects differ
no unsupported licensing, CBN-admission, settlement, provider-activation, or filing claim
```

Run the repository release evidence verifier only after the manifest and approvals are populated:

```bash
python3 scripts/infra/verify_production_release_evidence.py \
  --manifest assurance/evidence/release.json \
  --repo .
```

## P1 completion gate

P1 is closed only when P1-01 through P1-12 have named owners, approved artifacts, real staging evidence where external behavior is claimed, independent verification, and no unresolved P0. Local contract tests, synthetic identities, simulator outputs, or parsed configuration files cannot close a CBN external-evidence requirement.

## References

[1]: `/home/ubuntu/upload/CBN-Sandbox-CallForApplication-Cohort-2.pdf` — CBN Regulatory Sandbox Programme – Cohort 2, especially pp. 3–5 and 8.
[2]: `/home/ubuntu/UmojaFlowOS/assurance/cbn_cohort2_p0_p1_remediation_plan.md` — UmojaFlowOS P0/P1 remediation plan.
[3]: `/home/ubuntu/UmojaFlowOS/docs/compliance/vasp-evidence-closure.md` — VASP evidence closure programme.
