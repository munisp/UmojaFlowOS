# CBN Sandbox Cohort 2 VASP P0/P1 Remediation Plan

**Scope:** Close the highest-priority gaps identified in the UmojaFlowOS CBN Cohort 2 VASP analysis. This plan addresses cohort application and controlled-live-testing readiness; it does not claim licensing or regulator admission.

**Source:** Attached *CBN Regulatory Sandbox Programme – Cohort 2* call document, pages 1–9, especially the eligibility, testing safeguards, incident, evaluation, post-sandbox, application, and assessment sections. [1]

## Release principle

The CBN call requires the applicant to demonstrate a sufficiently developed solution ready for controlled live testing, identified and mitigated legal/financial/operational/technology/cyber/consumer risks, governance and resilience arrangements, AML/CFT/CPF controls where applicable, reporting/monitoring/incident capacity, and clearly defined parameters that avoid unacceptable risk. [1, pp. 3–4]

UmojaFlowOS should therefore be treated as **conditionally ready to prepare a cohort application**, but not ready to represent itself as a live VASP, custodian, exchange, settlement network, or regulatory filing channel.

## P0 closure workstream

P0 items are either application-blocking or controlled-live-test-blocking. Every P0 task must produce a versioned artifact, SHA-256 digest, accountable owner, independent reviewer, and immutable evidence location.

| ID | Task | Owner | Dependencies | Required implementation/output | Acceptance evidence |
|---|---|---|---|---|---|
| P0-01 | Freeze the proposed VASP product boundary | Product + Legal | Legal entity and counterparty identification | Produce a signed scope statement naming the exact tested product: for example, non-custodial payment-control infrastructure with authorised partners. Explicitly exclude custody, issuance, exchange, asset holding, final settlement, and regulator submission unless separately approved. | Signed product-boundary document; architecture-to-scope matrix; no contradictory claims in UI, API, marketing, or application form |
| P0-02 | Create the CBN application dossier | Company Secretary + Legal | P0-01, P0-03 through P0-08 | Assemble corporate/regulatory identity, ownership/UBO, board approval, accountable officers, innovation narrative, technology architecture, risk framework, customer documents, test plan, capacity evidence, exit plan, and post-sandbox model. | Completed application checklist and immutable dossier hash; all required CBN questionnaire annexes present |
| P0-03 | Obtain governance and accountability approvals | Board/Company Secretary | Named officers and role descriptions | Appoint accountable compliance/MLRO, security, product/risk, treasury/custody if applicable, consumer-protection, incident commander, and CBN liaison roles. Record alternates, conflicts, recusal rules, authority limits, and escalation routes. | Board/management resolutions; responsibility matrix; training and acknowledgement records |
| P0-04 | Define the bounded controlled-live test | Product + Risk + Compliance | P0-01, P0-03 | Specify eligible customers/counterparties, maximum population, transaction count/value, per-customer and aggregate exposure, velocity, corridors, currencies/assets, duration, start/stop criteria, excluded features, and test data rules. | Signed test plan; exported immutable configuration; proof limits are technically enforced and cannot be changed by participants |
| P0-05 | Complete real staging identity and secrets validation | Security + SRE | Provisioned Keycloak, Vault, PostgreSQL, gateway | Exercise Keycloak issuer/JWKS/audience/role validation, Vault OIDC authentication, primary secret rotation, deliberate primary-canary failure, compensating recovery, token revocation, TTL checks, TLS verification, and audit capture. | E-05 identity/provider evidence; workflow run IDs; Vault version metadata; canary and recovery records; no secrets in logs |
| P0-06 | Close AML/CFT/CPF and sanctions operating evidence | MLRO + Compliance + Provider Contact | Approved provider and staging credentials | Run real staging screening for clear, hit, false-positive, escalation, disposition, timeout, unavailable provider, and replay cases. Record source/version/reference, analyst decisions, timestamps, retention, escalation, and SAR/STR decision workflow without fabricating a filing receipt. | 14-item AML/CFT/CPF and Travel Rule evidence set; independently verified case traces; provider agreement/entitlement; failure-path report |
| P0-07 | Define Travel Rule boundary and test counterparty | MLRO + Legal + Provider Contact | P0-01, approved counterparty | Either implement a controlled exchange against an approved counterparty or explicitly exclude Travel Rule activity from the first test and obtain CBN agreement. Define schema, privacy, refusal/hold, retry, and no-production-data rules. | Counterparty approval, schema, secure trace, rejection/exception tests, or signed exclusion rationale |
| P0-08 | Complete customer protection package | Consumer Protection Owner + Legal | P0-04, P0-06 | Provide informed consent, risk disclosures, fees, stablecoin/FX/operational risk notices, complaints and dispute handling, exit/withdrawal rights, vulnerable-customer treatment, data rights, remedy/escalation, and orderly termination treatment. | Versioned customer documents; UI acceptance trace; de-identified complaint test; SLA evidence; independent usability/control review |
| P0-09 | Prove real financial and technical capacity | CFO/Treasury + SRE | P0-04 and provisioned staging | Provide capital/liquidity/reserve/safeguarding position where applicable, infrastructure sizing, throughput limits, staffing, on-call coverage, support model, third-party dependencies, and capacity/load evidence. | Capacity report, financial-capacity evidence, staffing/on-call roster, bounded load-test report |
| P0-10 | Execute E-01–E-09 on one immutable release | Release Manager + SRE | P0-04 through P0-09 | Deploy one SHA-bound release to segregated staging. Execute migration/schema, database integration, TigerBeetle, provider, deployment/rollback, observability, resilience, and security evidence collection. | Complete E-01–E-09 manifest; all hashes match; no local/simulator-only artifact used as external evidence |
| P0-11 | Complete four independent approvals | Release Manager, Security, Compliance, Operations | E-01–E-09 | Generate exactly four SHA-bound approval objects with distinct subjects and only allowed fields. Each approver independently reviews the same immutable evidence bundle. | `verify_production_release_evidence.py` passes; four valid approvals; no duplicate subjects or unresolved exceptions |
| P0-12 | Submit through the official CBN portal | Company Secretary + Authorised Signatory | P0-02 and P0-11 | Complete the CBN portal application, upload required documents, verify application accuracy, and submit before the stated deadline if the call remains open. | Portal submission receipt and immutable copy of submitted package |

## P1 closure workstream

P1 tasks strengthen operational credibility and ensure the proposed test can be supervised, monitored, suspended, and exited safely.

| ID | Task | Owner | Dependencies | Required implementation/output | Acceptance evidence |
|---|---|---|---|---|---|
| P1-01 | Implement the CBN test-control profile | Product + Risk | P0-04 | Store the approved test limits as immutable/versioned configuration. Enforce customer, counterparty, value, velocity, geography, product, and duration limits server-side. Refuse changes without authorised dual control and audit evidence. | Negative tests for every limit; configuration digest; attempted unauthorized-change evidence |
| P1-02 | Complete suspension and termination controls | Operations + Risk | P0-04, P0-08 | Implement kill switches, provider-disable gates, pending-order treatment, customer notification, refunds/returns where applicable, reconciliation freeze, evidence export, and residual-data cleanup. | Staging suspension/termination rehearsal; no new external movement after freeze; customer/counterparty treatment record |
| P1-03 | Make incident reporting operational | Incident Commander + CBN Liaison | P0-03, P0-08 | Configure classification, severity, 24-hour discovery clock, on-call escalation, CBN liaison workflow, templates, evidence preservation, and post-incident review. | Timed tabletop/technical exercise covering cyber, fraud, data breach, operational failure, regulatory breach, and consumer harm |
| P1-04 | Prove monitoring and notification delivery | SRE + Security | Provisioned Prometheus/Alertmanager/PagerDuty/Wazuh | Scrape Keycloak/Vault/ledger/provider/worker metrics; route critical alerts; verify PagerDuty/Wazuh receipt; document human acknowledgement and escalation. | E-07 live target and alert evidence; correlation ID; receiver acknowledgement; dashboard with live series |
| P1-05 | Complete TigerBeetle and PostgreSQL reconciliation | Treasury + Engineering | Approved staging cluster and schema | Run real transfers, idempotency, missing/unexpected/field-mismatch tests, reconciliation, timeout/indeterminate handling, consensus-loss rehearsal, and recovery. Stop payment execution on indeterminate status. | E-04 cluster identity/quorum/transfer/reconciliation/failover evidence; zero unexplained discrepancies |
| P1-06 | Complete deployment rollback and restore | Release Manager + SRE | Immutable image/provenance and staging | Verify signed image/provenance/SBOM, deploy, health gate, induce failed rollout, execute rollback, restore backup, reconcile, and verify post-rollback service state. | E-06 deployment/rollback receipt, restore report, image digest, SBOM, provenance, health evidence |
| P1-07 | Validate WORM and audit retention | Compliance + Security + SRE | MinIO/S3-compatible Object Lock or approved WORM store | Verify compliance retention, legal hold, detached signature, digest, archive completeness, tamper detection, authorized deletion, and restore. Keep cleanup soft-delete-only and separate from routine rotation. | WORM metadata, signature verification, tamper negative test, hold negative test, restore evidence, E-09 security review |
| P1-08 | Complete resilience and chaos evidence | SRE + Operations | Provisioned staging and approved fault window | Run network partition, connection-pool saturation, Keycloak/Vault timeout, provider timeout, alert delivery failure, ledger failover, and retention-worker mTLS faults. Capture detection, containment, reconciliation, recovery, and timings. | E-08 report with fault injection, alerts, recovery, RTO/RPO, and residual-risk review |
| P1-09 | Complete privacy and data-flow governance | Privacy + Security | P0-08 and real data-flow map | Map personal, identity, transaction, wallet, document, screening, and telemetry data. Define purpose, minimisation, retention, access, deletion/hold, cross-border transfers, processors, and customer rights. | Approved data-flow diagram, privacy impact assessment, retention schedule, access review, deletion/hold tests |
| P1-10 | Define post-sandbox pathway | Legal + CBN Liaison + Product | P0-01, test objectives | State the intended outcome: existing framework, licence/authorisation application, further supervised development, enhanced supervision, coordinated authority pathway, or discontinuation. Identify required authorities and milestones. | Signed post-sandbox operating/regulatory model and exit/transition plan |
| P1-11 | Produce Nigeria-specific impact assessment | Risk + Economics/Policy | P0-04, P1-10 | Assess financial stability, monetary sovereignty, FX/stablecoin risk, reserves/redemption, consumer harm, fraud, systemic concentration, market integrity, competition, inclusion, and public-interest impact. | Board-approved impact assessment with measurable mitigations and test thresholds |
| P1-12 | Establish independent evidence verification | Compliance + Internal Audit | E-01–E-09 artifacts | Enforce HTTPS artifact URI, SHA-256 matching, owner attribution, version/time, different submitter/verifier subject, external attestation where required, and no claims of licensing or regulator acceptance without authoritative records. | Passing evidence verifier; independent verification log; exception register with closure decisions |

## Sequencing and decision gates

| Gate | Must be true before proceeding |
|---|---|
| Gate 0 — Application integrity | P0-01 through P0-03 complete; legal entity, ownership, accountable officers, product boundary, and board approval are consistent |
| Gate 1 — Test safety | P0-04 and P0-08 complete; test limits, consent, disclosures, complaint, exit, and termination rules are approved |
| Gate 2 — External readiness | P0-05 through P0-09 complete; real staging dependencies and provider/counterparty prerequisites exist |
| Gate 3 — Controlled-test evidence | P0-10 and P1-02 through P1-08 complete; E-01–E-09 are populated from executed staging evidence |
| Gate 4 — Independent assurance | P0-11 and P1-12 complete; four approvals are distinct, SHA-bound, and independently verified |
| Gate 5 — Submission | P0-12 complete; application package is accurate, complete, and submitted through the official portal |

A failed gate stops progression. In particular, an unavailable screening provider, unknown ledger state, WORM verification failure, alerting failure, invalid release evidence, customer-harm event, or inability to suspend the test must not be converted into a passing synthetic result.

## Exact CBN requirements extracted from the attached document

> “All applicants must demonstrate that: (a) the proposed solution is sufficiently developed and ready for controlled live testing; (b) the innovation addresses an identified market need or provides a clear benefit to consumers, businesses, the financial system, or the wider economy; (c) the principal legal, financial, operational, technological, cybersecurity, and consumer risks have been identified and appropriately mitigated; (d) appropriate governance, consumer protection, data protection, cybersecurity, and operational resilience arrangements are in place; (e) effective Anti-Money Laundering, Countering the Financing of Terrorism, and Counter-Proliferation Financing controls have been established, where applicable; (f) the applicant has the operational and technical capacity to comply with the reporting, monitoring, testing, and incident-notification requirements of the Sandbox; and (g) the proposed innovation can be tested within clearly defined parameters without posing unacceptable risks to consumers, the financial system, or the wider public.” [1, p. 3]

> “Before commencing live testing, participants must demonstrate satisfactory arrangements for: (a) customer identification and onboarding; (b) informed customer consent and appropriate risk disclosures; (c) customer exit rights and arrangements for the orderly treatment of customers at the conclusion or termination of testing; (d) complaints handling and dispute resolution; (e) protection of vulnerable customers, where relevant; (f) cybersecurity and information security; (g) data protection, privacy, and appropriate customer control over personal data; (h) operational resilience and business continuity; (i) fraud prevention and transaction monitoring; (j) incident detection, management, and reporting; (k) safeguarding of customer funds and assets, where applicable; (l) record keeping and regulatory reporting; and (m) the orderly scaling, suspension, transfer, or termination of the test.” [1, p. 5]

> “Participants must report, within 24 hours of discovery, material incidents arising during the testing period, including cybersecurity incidents, fraud events, data breaches, operational failures, regulatory breaches, or cases of actual or potential consumer harm.” [1, p. 5]

> “Approved participants will conduct testing only within the parameters set out in the Sandbox Testing Agreement and any additional directions issued by the CBN.” [1, p. 5]

> “Applications involving stablecoins, custody arrangements, wallet infrastructure, token issuance, smart contracts, or other virtual asset structures must include the relevant governance, technology, reserve management, disclosure, consumer protection, and risk-control documentation specified in the Sandbox application questionnaire.” [1, p. 3]

> “Applications will be assessed against criteria including: (a) completeness and accuracy of the submission; (b) eligibility of the applicant and proposed innovation; (c) degree of innovation and potential market benefit; (d) readiness for controlled live testing; (e) alignment with the scope and objectives of Cohort 2; (f) adequacy of governance, risk management, compliance, and consumer protection arrangements; (g) technical and operational capacity; (h) the feasibility of the proposed testing and exit plans; (i) the clarity and viability of the proposed post-Sandbox regulatory pathway; (j) the potential impact on financial stability, monetary sovereignty, consumers, market integrity, and the payments ecosystem; and (k) overall suitability for testing within the CBN Regulatory Sandbox.” [1, p. 8]

> “Successful completion of Sandbox testing does not automatically confer a license, approval, authorization, registration, or entitlement to operate.” [1, p. 6]

## Completion definition

The P0/P1 programme is closed only when the application dossier is complete, the controlled-test profile is approved internally, real staging evidence is captured against one immutable release SHA, all external dependencies are attested, incident/consumer/exit safeguards are exercised, the evidence verifier passes, and the four independent approvals are valid.

Even after that point, the status is **eligible to seek CBN Sandbox admission and conduct approved testing**, not licensed or authorised for unrestricted live operation.

## References

[1]: `/home/ubuntu/upload/CBN-Sandbox-CallForApplication-Cohort-2.pdf` — Central Bank of Nigeria, *Call for Applications: CBN Regulatory Sandbox Programme – Cohort 2*, pp. 1–9.

[2]: `/home/ubuntu/UmojaFlowOS/docs/compliance/vasp-evidence-closure.md` — UmojaFlowOS external evidence closure programme.

[3]: `/home/ubuntu/UmojaFlowOS/assurance/requirements_traceability.md` — UmojaFlowOS mission-critical assurance traceability register.

[4]: `/home/ubuntu/UmojaFlowOS/assurance/feature_completeness_inventory.md` — UmojaFlowOS feature-completeness and trust-boundary inventory.
