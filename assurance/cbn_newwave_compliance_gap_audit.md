# Newwave CBN Sandbox application — compliance-gap and regulatory-risk audit

**Status: Draft for authorised Newwave and counsel review.** This audit compares the current authorised-data intake sheet and application draft with the supplied CBN Regulatory Sandbox Framework and DEC VASP application form. It is not legal advice and does not determine eligibility.

## Executive assessment

The intake sheet is directionally complete for the major evidence families, but it is not yet sufficient as a submission-control register. The most material unresolved issue is **applicant identity and jurisdiction**: public NewWave material identifies a Maryland-based US technology company, while the CBN VASP form and sandbox process require a clear Nigerian connection, exact applying entity, ownership/UBO evidence, local regulatory perimeter, and controlled test arrangements. UmojaFlowOS technical readiness cannot cure an unverified legal or regulatory perimeter.

The current application posture is **NO-GO for filing** until the high-severity items below are evidenced and approved.

## Missing compliance items

| ID | Missing or under-specified item | Severity | Why it matters | Required closure evidence | Owner |
| --- | --- | --- | --- | --- | --- |
| C-01 | Exact applicant entity and Nigerian legal connection | Critical | The public website identifies NewWave Telecom and Technologies, Inc. in Maryland, but the filing entity and Nigerian basis are not confirmed. | Certificate, registry extract, Nigerian entity/partner records, counsel perimeter memo | Legal / Board |
| C-02 | CBN versus SEC jurisdiction analysis | Critical | VASP activities may engage more than one Nigerian regulator or licence category. | Signed Nigerian counsel opinion and regulator-perimeter matrix | Legal / Compliance |
| C-03 | Complete ownership, UBO, PEP, source-of-wealth and source-of-funds package | Critical | These are mandatory form fields and financial-crime controls. | Current signed structure chart, shareholder table, UBO IDs, declarations, source evidence | Company Secretary / MLRO |
| C-04 | Board approval and authorised signatory mandate | Critical | The form and framework require authoritative approval and signed submission. | Board resolution/minutes and signatory authority record | Board / Legal |
| C-05 | Nigerian tax, incorporation, BVN and local contact handling | High | The form requests TIN and CEO/MD BVN where applicable and requires reliable official contacts. | Applicability memo, official contact, secure CBN submission plan | Finance / Legal |
| C-06 | Board, senior-management, compliance-officer and local liaison evidence | Critical | Public leadership listings do not prove board membership, local responsibility, AML competence, or fit-and-proper status. | CVs, appointments, declarations, organogram, reporting lines | HR / Compliance |
| C-07 | Independent MLRO/CCO reporting line | Critical | The form explicitly asks whether the MLRO/CCO reports independently to Board/Risk/Audit Committee. | Charter, appointment, reporting-line diagram, committee minutes | MLRO / Board |
| C-08 | Regulatory and enforcement-history declarations | High | Omissions or inaccurate answers can create disqualification and enforcement risk. | Jurisdiction-by-jurisdiction signed declarations and search methodology | Legal / Compliance |
| C-09 | Capital, liquidity, audited accounts and bank evidence | Critical | The form asks for financial capacity, runway and bank evidence. | Audited accounts, management accounts if applicable, statements, runway model, CFO certification | CFO |
| C-10 | Precise VASP category selection | Critical | Selecting an activity implies regulatory and operational obligations. | Product/legal classification matrix with selected categories and exclusions | Product / Legal |
| C-11 | Numeric sandbox limits | Critical | The framework expects limited transaction value and volume; the current draft has no approved numbers. | Signed test-limit schedule for single transaction, daily volume, users, cash/assets | Product Risk / Treasury |
| C-12 | Participant, consent and consumer-protection plan | High | Testing with volunteers requires clear disclosures, eligibility, consent, complaints and remediation. | Participant policy, consent form, complaint SLA, refund/wind-down plan | Consumer Protection / Legal |
| C-13 | AML/CFT/CPF operating procedures | Critical | A high-level policy is insufficient without risk methodology, CDD/EDD, monitoring, escalation, STR/SAR process and records. | Approved AML manual, scenarios, case workflow, training and test results | MLRO |
| C-14 | Travel Rule protocol and provider | Critical | VASP testing involving transfers must address originator/beneficiary data and retention. | Procedure, provider assessment or justified non-applicability memo, test logs | MLRO / CTO |
| C-15 | Third-party due diligence and concentration risk | High | Screening, Travel Rule, hosting, identity, ledger, custody and financial-institution dependencies can create systemic failure paths. | Contracts/LOIs, due diligence, data maps, SLAs, exit plans | Procurement / Security |
| C-16 | Privacy and cross-border data-transfer analysis | Critical | The applicant appears US-based and may process Nigerian personal data through cross-border services. | Nigerian data-protection analysis, DPA, transfer safeguards, retention/deletion schedule | DPO / Legal |
| C-17 | Wallet, custody and customer-asset perimeter | Critical | The draft says non-custodial, but this must be technically and legally enforceable. | Architecture, key-flow proof, customer-asset attestations, custody exclusion controls | Treasury / Security |
| C-18 | Token/stablecoin non-applicability or full issuer package | High | The form asks specific token and reserve questions. | Board-approved non-issuance declaration or complete whitepaper/reserve/legal package | Legal / Product |
| C-19 | Cybersecurity, penetration testing and vulnerability closure | High | Public HITRUST/CMMI statements are not current scope-specific evidence for the proposed VASP platform. | Current certificate scope, pen-test report, remediation report, independent assessment | CISO |
| C-20 | Operational resilience and controlled failure evidence | Critical | The sandbox requires risk controls, incident reporting, exit, and final reporting. | BCP/DR, RTO/RPO, rollback test, incident exercise, E-01–E-09 real evidence | COO / CISO |
| C-21 | Reporting and record-retention commitments | High | The framework requires periodic/final reports and records retained for up to five years. | Reporting calendar, CEO confirmation process, retention/WORM verification | Compliance / COO |
| C-22 | Application submission mechanics | High | The framework references an official portal, cover letter, email route, and specific addressees. | Final portal checklist, signed cover letter, secure attachment register | Authorised Signatory |

## Regulatory risk register

| Risk | Rating | Trigger | Preventive control | Residual requirement |
| --- | --- | --- | --- | --- |
| Wrong applying entity or no Nigerian nexus | Critical | Entity, Nigerian branch, partner or local representative cannot be evidenced | Freeze filing until counsel confirms perimeter | C-01 closure |
| Unauthorised VASP activity | Critical | Product performs custody, exchange, brokerage, payment, issuance or settlement outside approved scope | Product-boundary allowlist and fail-closed policy | C-02 and C-10 closure |
| Misleading or incomplete application | Critical | Public claims substituted for corporate records or required fields left ambiguous | Evidence register with owner/reviewer and no-fabrication control | C-03 through C-09 closure |
| AML/CFT/CPF failure | Critical | Screening outage, weak CDD/EDD, poor PEP/sanctions handling, missed STR escalation | Fail-closed onboarding/execution, MLRO oversight, scenario tests | C-13 closure |
| Travel Rule non-compliance | High | Originator/beneficiary data absent, incomplete or not retained | Transfer gating and provider/non-applicability decision | C-14 closure |
| Consumer harm or uncontrolled losses | Critical | Test limits, consent, refund and exit process are not operational | Hard transaction/user limits, consent, reconciliation and wind-down | C-11/C-12/C-20 closure |
| Data-protection breach | Critical | Cross-border processing, excessive retention, unprotected identity/transaction data | Data minimisation, encryption, access logs, DPA and retention controls | C-16 closure |
| Third-party outage or concentration | High | AML, identity, Travel Rule, ledger, hosting or settlement dependency fails | Tested timeouts, circuit breakers, manual pause, alternate/exit plan | C-15/C-20 closure |
| Evidence tampering or unverifiable approval | High | Artifact digest mismatch, duplicate approvers, mutable store | SHA-256 manifest, immutable store, independent E-09 review | C-20/C-21 closure |
| False impression of licence | Critical | Marketing or application language suggests sandbox admission equals licence | Explicit no-license statement and legal review | C-10/C-18/C-22 closure |

## Additions required to the intake sheet

The intake sheet should be expanded to include: the exact Nigerian legal-entity and jurisdiction decision; SEC/CBN perimeter analysis; Nigerian data-protection analysis; regulatory/enforcement search methodology; product-category decision tree; quantified customer-loss and fraud scenarios; participant consent and complaints workflow; test-limit approval record; bank/settlement partner dependency matrix; reporting calendar and five-year record-retention plan; evidence-owner/reviewer segregation; and a formal final-submission quality-control checklist.

## Immediate decision

Do not submit or represent this draft as complete. Obtain the C-01, C-02, C-03, C-04, C-06, C-07, C-09, C-10, C-11, C-13, C-14, C-16, C-17 and C-20 evidence first. The public NewWave website is useful corroboration for identity and capabilities, but it is not a substitute for those controlled records.

## References

[1]: https://newwave.io/about-us/ "NewWave About Us"
[2]: https://newwave.io/leadership-team/ "NewWave Leadership Team"
[3]: https://newwave.io/capabilities/ "NewWave Capabilities"
[4]: https://sandbox.cbn.gov.ng/ "CBN Regulatory Sandbox Cohort 2 portal"
[5]: https://www.cbn.gov.ng/ "Central Bank of Nigeria"

The supplied source documents are `/home/ubuntu/upload/CentralBankofNigeriaRegulatorySandboxFramework.pdf` and `/home/ubuntu/upload/DEC-responses.pdf`.
