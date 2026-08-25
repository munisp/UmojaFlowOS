# UmojaFlowOS AML/CFT/CPF, Travel Rule, and Controlled Live-Test Evidence Guide

> **Important distinction.** The readiness register contains **one 14-point area** named `aml_cft_cpf_operations`; it does **not** contain 14 separately scorable database rows. The 14 items below are the operational evidence checklist that should make up the one signed evidence bundle. The register may award the 14 points only when that bundle is independently verified. This is an internal evidence workflow, not a CBN admission, licence, or final regulatory determination.

## 1. The 14-point AML/CFT/CPF and Travel Rule evidence area

The repository already contains two supporting evidence structures. The VASP supervisory record includes `aml_cft_cpf_and_travel_rule_programme`; the per-counterparty Travel Rule register separately requires originator data, beneficiary data, secure exchange design, counterparty identity/authorisation, and exception/rejection handling. The 58-point assurance register then combines the operational outcome into the single 14-point area.

| # | Evidence artifact that must exist | What a reviewer must test | Operational owner |
|---:|---|---|---|
| 1 | Board-approved AML/CFT/CPF policy and named MLRO appointment | The policy is current, applies to the proposed VASP scope, and the MLRO has documented authority, escalation access, and resources. | MLRO / Board |
| 2 | Enterprise-wide AML/CFT/CPF risk assessment | It identifies customers, products, corridors, channels, geographies, virtual-asset risks, counterparties, and residual controls. | MLRO / Risk |
| 3 | Customer, beneficiary, and counterparty risk-rating methodology | Ratings are documented, applied consistently, and drive enhanced due diligence, approval, monitoring, and review frequency. | Compliance |
| 4 | CDD/KYB, beneficial-ownership, PEP, sanctions, and adverse-media procedures | The procedure and sample evidence demonstrate identity/ownership checks, escalation, refresh, and adverse result handling. | Compliance / Operations |
| 5 | Screening provider configuration and test evidence | The approved provider scope, matching rules, data source, false-positive review, test cases, and fail-closed outage handling are evidenced. | Compliance / Technology |
| 6 | Transaction-monitoring scenario and typology catalogue | Scenarios cover the approved product/corridor risks; thresholds, tuning ownership, alerts, and periodic effectiveness review are documented. | MLRO / Financial Crime Operations |
| 7 | Case-management and alert-investigation runbook | A sample alert shows case creation, investigator assignment, evidence preservation, escalation, decision, QA, and SLA measurement. | Financial Crime Operations |
| 8 | Suspicion escalation and statutory-reporting procedure | The organisation has a governed referral and filing decision path; a controlled simulation may evidence the process without fabricating an external filing. | MLRO / Legal |
| 9 | Financial-crime training, competence, and independent testing | Required staff completed role-appropriate training; independent assurance tested programme design and operation, with remediation tracked. | MLRO / HR / Internal Audit |
| 10 | Originator-information schema | The Travel Rule payload has required originator fields, validation, traceability, privacy controls, and rejection rules. | Compliance / Engineering |
| 11 | Beneficiary-information schema | The payload has beneficiary fields, validation, traceability, privacy controls, and rejection rules. | Compliance / Engineering |
| 12 | Secure counterparty-exchange design | Documented authenticated transport, encryption, message integrity, idempotency, retention, monitoring, and interoperability test results. | Security / Engineering |
| 13 | Counterparty identity and authorisation evidence | The counterparty’s identity, jurisdictional authority, scope, technical contact, due diligence, and periodic recertification are independently supported. | Legal / Compliance / Provider Management |
| 14 | Exception, rejection, and escalation handling | Missing/invalid data, unverified counterparties, screening hits, outages, retries, manual review, customer communications, and incident escalation are tested. | Compliance / Operations / Engineering |

### What does not close these points

A mock screening response, an untested API key, an internal policy draft, a code review, or an unexecuted test plan does not establish operating AML/CFT/CPF or Travel Rule capability. Similarly, a technical adapter should not decide whether a case is clear or whether a transfer may settle; it should produce evidence for governed human and policy workflows.

## 2. How the 14-point area is recorded and verified in UmojaFlowOS

### Recording flow

The MLRO/compliance owner prepares an **evidence bundle** rather than one undifferentiated document. The bundle should contain a machine-readable index that maps all 14 artifacts above to immutable source locations, SHA-256 values, owner, document version, approval date, scope, and any test sample references.

The compliance or administrator user records the bundle by calling `postgres.recordReadinessAssuranceEvidence` with:

```json
{
  "dossierId": "<existing-VASP-dossier-UUID>",
  "area": "aml_cft_cpf_operations",
  "evidenceUri": "https://evidence.example/vasp/aml-travel-rule-bundle-manifest.json",
  "evidenceSha256": "<64-lowercase-hex-digest-of-the-bundle-manifest>"
}
```

This moves the area from `open` to `evidence_recorded`. The database requires the evidence URI, evidence hash, recorder subject, and timestamp. It does not mark the point as externally verified.

The system’s more granular records should also be completed:

| Supporting register | Categories to record |
|---|---|
| `vasp_regulatory_evidence_items` | `aml_cft_cpf_and_travel_rule_programme` in the supervisory VASP profile. |
| `vasp_travel_rule_evidence_items` | `originator_information_schema`, `beneficiary_information_schema`, `secure_counterparty_exchange_design`, `counterparty_identity_and_authorisation`, and `exception_and_rejection_handling` for each proposed counterparty. |
| `vasp_travel_rule_route_assessments` | An internal completeness assessment. A complete outcome remains `internal_record_complete_pending_external_review`; it does not claim external counterparty verification or a real Travel Rule transmission. |

### Independent verification flow

A different administrator/auditor retrieves the exact bundle version, recomputes all hashes, confirms the 14-index mapping, checks source provenance, interviews/obtains attestation from the named external verifier where needed, and documents any exceptions. The verifier then calls `postgres.verifyReadinessAssuranceEvidence` with a named external verifier, HTTPS attestation URI, attestation SHA-256, and a rationale of at least 20 characters.

The database will accept `externally_verified` only if all evidence and attestation fields are present and **`verified_by <> evidence_recorded_by`**. It returns the 14 internal readiness points but continues to mark `externalApproval:false`, `licence:false`, and `admission:false`.

If any artifact is incomplete, stale, unverifiable, or inconsistent, the independent verifier calls the rejection procedure with a specific rationale. The source bundle remains recorded for auditability; it is not erased.

## 3. The controlled live test: the seven-point area

The seven points do not mean “send seven payments” or “turn the provider on.” They mean that a bounded live-test programme exists, runs only with all required external approvals, produces evidence, and can be safely wound down.

The implemented `cbnSandboxTestPlan` object can document:

| Required plan component | What UmojaFlowOS can store | What remains external or operational |
|---|---|---|
| Permitted use | Defined product/test scope | Confirmation that the scope is legally and regulator-approved. |
| User category | Defined participant class | Participant eligibility, consent, onboarding, and protection. |
| Maximum transactions | Numeric transaction cap | Monitoring and enforcement under the approved live-test conditions. |
| Maximum aggregate exposure | Aggregate cap | Treasury/custody capacity and board-approved risk appetite. |
| Start/end dates | Bounded test window | Written authority to start, pause, extend, or stop. |
| Success metrics URI | Evidence location for metrics | Objective results from an actual controlled test. |
| Wind-down URI | Evidence location for exit plan | Tested ability to suspend, reconcile, notify, and close the test. |

When a plan is created in UmojaFlowOS, the service records it as `documented` and explicitly writes `executionPermitted:false`, `settlementPermitted:false`, and `externalApprovalAsserted:false`. This is intentional: **documenting a plan never authorises execution.**

## 4. Controlled live-test execution model

### Gate 0 — External authority and internal approvals

Before any test execution, obtain the applicable written regulator/sandbox authority, legal confirmation of the permitted scope, board/regulated-entity approval, provider sandbox/test entitlement, insurance/custody prerequisites, approved customer disclosures, and emergency contacts. Load only the authorised parameters into the staging/test environment. Keep all other provider, ledger, screening, and settlement flags disabled.

### Gate 1 — Test readiness rehearsal

Perform a non-financial rehearsal of the complete flow: KYC/KYB and consent, risk classification, screening hit, Travel Rule data validation, provider outage, webhook replay, ledger projection failure, incident escalation, complaint intake, report-pack generation, and wind-down. Record expected and observed results. A failed rehearsal blocks progression.

### Gate 2 — Bounded execution

Only after external written approval is independently recorded should the accountable operators enable the specifically approved test configuration. Enforce the approved user cohort, transaction ceiling, aggregate exposure ceiling, permitted corridors, operating window, and real-time stop controls. Every exception must default to manual review or block—not a silent retry or automated approval.

### Gate 3 — Continuous evidence collection

During the test, capture service-health/SLO samples, screening and case evidence, Travel Rule validation/rejection events, ledger reconciliations, customer consent and complaint records, provider acknowledgements, incident records, and a daily immutable audit batch. Independent observers should have read-only access to the evidence and defined escalation paths.

### Gate 4 — Completion, reconciliation, and wind-down

At the approved end date or any stop trigger, freeze new transactions, reconcile all ledger/provider/custody evidence, preserve audit batches, notify affected participants as required, resolve outstanding cases, disable the relevant configuration, and perform a wind-down rehearsal. Assemble an evidence-backed reporting pack with its SHA-256 digest.

### Gate 5 — Independent review and external decision

The independent reviewer assesses whether the stated success criteria, caps, controls, incidents, complaints, reconciliation, and wind-down were satisfied. UmojaFlowOS can record the test artifacts and internal readiness assessment only. **The CBN and the responsible regulated entity—not UmojaFlowOS—decide whether an application is admitted, a test is acceptable, a licence is granted, or production operation may proceed.**

## References

[1]: https://sandbox.cbn.gov.ng/ "Central Bank of Nigeria Regulatory Sandbox"
[2]: `apps/control-plane/server/vaspReadiness.ts` and `apps/control-plane/server/cbnSandbox.ts`, UmojaFlowOS local implementation sources.
