# UmojaFlowOS Stakeholder User Manual

**Audience:** CBN and other public-sector supervisors, ministries, licensed financial institutions, VASPs, compliance teams, operations teams, auditors, technology partners, and citizens participating in a controlled programme.

**Status:** Operational guide for controlled non-production or approved sandbox use. It does not grant a licence, authorise custody, permit unrestricted payments, or replace a regulator, bank, VASP, legal adviser, or data-protection officer.

## 1. What UmojaFlowOS is

UmojaFlowOS is a control and evidence platform for regulated digital-finance workflows. It brings identity, onboarding, risk assessment, controlled execution, reconciliation, incident response, reporting, and evidence preservation into one governed operating model.

The platform is designed to help an authorised institution or supervised sandbox participant prove that material actions are bounded, attributable, reviewable, reversible where appropriate, and reported to the right stakeholders. It remains fail-closed when a required identity, policy, external provider, ledger, approval, or evidence dependency is unavailable.

## 2. User roles

| Stakeholder | Primary use | What the role must not do alone |
|---|---|---|
| CBN or public supervisor | Review test boundaries, reports, incidents, and evidence | Operate a participant’s internal payment authority |
| Ministry or policy team | Review impact, market trends, financial-integrity indicators, and programme outcomes | Treat scenario analytics as audited fiscal forecasts |
| Board or authorised signatory | Approve scope, risk appetite, governance, and submission posture | Approve a transaction or release without required independent roles |
| Compliance / MLRO | Review KYC/KYB, screening, alerts, escalations, Travel Rule exceptions, and SAR/STR decisions | Self-approve a conflict-prone action |
| Security owner | Review identity, access, key rotation, vulnerability, and incident evidence | Override a compliance or financial-control gate without authority |
| Operations owner | Run controlled workflows, monitor service health, execute recovery, and maintain runbooks | Change policy or approve their own production release |
| Treasury / ledger operator | Review balances, postings, reconciliations, and exceptions | Change customer or compliance records to hide a discrepancy |
| Auditor / independent reviewer | Verify hashes, approvals, evidence completeness, and control operation | Modify the evidence under review |
| Technology partner | Integrate approved APIs, identity, ledger, messaging, and evidence stores | Use test credentials or customer data outside the approved boundary |
| Citizen / test participant | Provide consent, view disclosures, transact within limits, and raise complaints | Be exposed to activity outside the approved test perimeter |

## 3. Standard application flow

### Step 1: Sign in and establish authority

The user signs in through the approved Keycloak identity realm. The system validates issuer, audience, signature, expiry, account state, and role. A user sees only the workflows allowed by their assigned role and current approval state.

### Step 2: Create or review an onboarding record

An operator creates a customer, business, counterparty, or partner record. The record captures the minimum information needed for the approved use case, consent, source references, beneficial-ownership evidence where applicable, and the initial risk category. No raw identity document should be copied into an ordinary audit record.

### Step 3: Run risk and compliance checks

The system sends the permitted data to the approved screening or verification service. It records the provider name, source/version, request reference, outcome, timestamp, analyst decision, and escalation. A hit, stale response, unavailable provider, malformed response, or replayed response places the workflow into review or hold; it does not silently pass.

### Step 4: Apply transaction and exposure limits

Before a test order is accepted, the platform checks participant status, customer consent, test limits, counterparty approval, corridor restrictions, sanctions status, required approvals, and service health. Exceeding a limit causes refusal or manual review.

### Step 5: Execute only an authorised workflow

The payment engine validates the order and provider webhook. The ledger gateway validates balance and double-entry structure. The platform does not treat a successful request receipt as final settlement. An external payment, custody, exchange, or bank action must be performed by an authorised provider under an approved integration.

### Step 6: Reconcile

Operations compares the payment order, provider event, PostgreSQL projection, and TigerBeetle fact where enabled. Missing intents, unexpected facts, duplicate events, field mismatches, or indeterminate ledger status stop further execution until resolved.

### Step 7: Monitor and respond

Prometheus, Alertmanager, Wazuh, and the operational console surface health, authentication, reconciliation, latency, circuit-breaker, retention, and segregation-of-duties exceptions. The incident commander assigns severity, preserves evidence, coordinates notification, and records recovery.

### Step 8: Report and preserve evidence

The reporting service assembles permitted aggregates and evidence packets. E-01 through E-09 artifacts are hashed and stored in the approved immutable evidence store. The system separates confidential evidence from public code and never treats a synthetic fixture as regulatory proof.

### Step 9: Exit or transition

At test completion, operations reconciles all records, handles customer withdrawal or refund obligations, closes incidents, preserves required records, and produces an exit report. A post-sandbox licence or partnership decision is separate from sandbox admission.

## 4. How to use the main modules

### Control Plane

Use the control plane to manage users, roles, authorities, workflows, approvals, and regulated evidence state. Start every material action here. Review pending approvals and conflicts before performing a write action.

### Payment Engine

Use the payment engine to validate orders, webhooks, timestamps, replay protection, source-network rules, and workflow state. Do not place a live provider secret in the application configuration or commit it to source control. Provider execution remains disabled until the authorised provider, credential, allowlist, and staging evidence gates pass.

### Ledger Gateway

Use the ledger gateway to validate balanced postings and compare ledger facts with the PostgreSQL projection. Treat an indeterminate response as unresolved. Never manually mark a transfer complete to bypass reconciliation.

### Risk and Compliance Core

Use this module to create cases, review screening results, record analyst dispositions, escalate potential matches, and preserve AML/CFT/CPF and Travel Rule evidence. It is a review and control service; it does not replace the MLRO’s judgement or the regulator’s authority.

### Reporting and Analytics

Use the reporting module for jurisdiction-level, de-identified aggregates, regulatory packs, exposure calculations, and evidence indexes. Apply data minimisation. Raw KYC/KYB bytes, secrets, tokens, account numbers, and unredacted identifiers must not enter analytics exports.

### Document Intelligence

Use document intelligence to assist with document review, provenance, liveness, and deepfake/PAD signals. All signals remain review-required and non-decisional unless an authorised human process explicitly approves the next action.

### Retention Delete Gateway

Use the retention gateway only for authorised retention decisions. It checks legal holds, WORM state, signed manifests, single-use authorisations, scope, and database claims before a delete action. A missing verification or signature fails closed.

### Operations and monitoring

Use the operations console and dashboards to inspect health, error rates, queue depth, alert state, reconciliation status, and recovery actions. A green dashboard is not by itself evidence of regulatory readiness; evidence must show the deployed version, test conditions, timestamps, and independent verification.

## 5. Control principles

1. **Least privilege:** users receive only the permissions required for their role.
2. **Segregation of duties:** initiation, approval, compliance review, release, and reconciliation are separated.
3. **Fail closed:** unavailable or contradictory dependencies prevent execution.
4. **Evidence first:** every material decision has an owner, reviewer, timestamp, source, and digest.
5. **Privacy by design:** collect the minimum data, retain it for an approved purpose, and restrict exports.
6. **No synthetic evidence claims:** test fixtures demonstrate software behavior only.
7. **No licence implication:** sandbox participation is not permanent regulatory authorisation.

## 6. Common actions and expected outcomes

| Action | Expected result |
|---|---|
| Screening service unavailable | Workflow enters hold or review; no execution |
| Duplicate webhook | Idempotency response; no duplicate posting |
| Ledger reconciliation mismatch | Exception created; further execution paused |
| Approval subject equals initiator | Segregation-of-duties rejection |
| Evidence hash mismatch | E-09 verification failure; release remains NO-GO |
| Legal hold present | Delete denied |
| Expired Keycloak token | Request denied and audit event created |
| Provider credential unhealthy | Provider execution disabled |
| Rollback health gate fails | Release is not promoted; incident workflow starts |

## 7. Support and escalation

The operations owner is the first responder for workflow issues. Security handles identity, access, certificates, and tampering. Compliance handles screening, customer protection, and regulatory interpretation. The CBN liaison handles approved notification and supervisory communication. Legal and the DPO handle legal perimeter, privacy, and data-subject questions.

## 8. Readiness boundary

UmojaFlowOS is not ready for live customer payment activation merely because local tests pass. Before live use, the organisation must provide real authorised identities, external credentials, licensed counterparties, staging deployment evidence, controlled failure tests, independent E-09 review, four distinct release approvals, and the applicable regulatory authorisations.
