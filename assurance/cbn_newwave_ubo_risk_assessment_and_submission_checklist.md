# Newwave CBN Sandbox Application
## UBO risk assessment and submission-readiness checklist

**Status: DRAFT — NOT FOR SUBMISSION.** This is a working regulatory-control assessment, not formal legal advice. A Nigerian-qualified lawyer and an authorised Newwave officer must review the final ownership, regulatory-perimeter, AML/CFT/CPF, and filing positions before use.

## 1. Assessment basis

The supplied DEC CBN Regulatory Sandbox VASP Application Form asks the applicant to identify all shareholders holding 5% or more, provide ownership information, identify **all ultimate beneficial owners**, provide UBO biographical and identification information, explain source of wealth and source of funds, list UBO interests in other companies, and disclose politically exposed person status. The supplied CBN framework also requires accurate and complete supporting information and allows regulatory action for false or misleading submissions. The official CBN Sandbox Cohort 2 portal describes the programme as a controlled testing environment and links the application route and framework.[1][2]

The public NewWave materials reviewed identify NewWave Telecom and Technologies, Inc. and mention NewWave Holdings, LLC and related entities, but they do not establish the current share register, control rights, UBOs, Nigerian entity or partner, or the legal perimeter for the proposed VASP-track activity.[3][4]

## 2. Overall UBO risk conclusion

**Current UBO posture: Critical / NO-GO.** No UBO information should be inferred from the founder title, public leadership page, parent-company references, social-media profiles, or third-party databases. The application cannot be considered complete until the exact applying entity and all direct and indirect ownership and control paths are documented, reconciled to authoritative records, independently reviewed, and securely submitted.

The primary exposure is not simply an omitted name. It is the possibility that the filing entity, parent chain, voting-control arrangement, nominee relationship, trust, contractual control, shareholder agreement, or related-party structure has not been fully disclosed. That can create application-integrity, AML/CFT/CPF, sanctions, PEP, licensing, tax, reputational, and enforcement risks.

## 3. UBO requirement interpretation

For this application, the UBO exercise should identify natural persons who ultimately own or control the applicant, whether through shares, voting rights, contracts, board rights, appointment rights, veto rights, financing arrangements, trusts, nominees, or other means. The working file must not stop at the first corporate shareholder. Every corporate shareholder must be traced to natural-person ownership or control, with documented reasons for each conclusion.

Where no natural person can be established after reasonable and documented investigation, the applicant should not silently leave the field blank. Legal counsel should determine the appropriate control-person treatment and document the search, rationale, and approval. This is a legal conclusion, not a data-entry shortcut.

## 4. UBO risk register

| ID | Risk | Severity | Failure mode | Required control | Closure evidence |
| --- | --- | --- | --- | --- | --- |
| UBO-01 | Wrong applying entity | Critical | Application is filed by a group company that does not own or operate the proposed activity. | Board-approved entity decision and legal-entity map. | Certificate, registry extract, board resolution, counsel memo. |
| UBO-02 | Incomplete ownership chain | Critical | Parent, subsidiary, affiliate, nominee, trust, or intermediate holding company is omitted. | Signed ownership chart to natural persons. | Current cap table, corporate registry extracts, shareholder register, ownership chart. |
| UBO-03 | Control without equity | Critical | A person controls decisions through voting agreements, appointment rights, financing, vetoes, or contracts but is not listed as a shareholder. | Separate control-rights questionnaire and legal review. | Shareholder agreements, operating agreements, trust deeds, board-rights schedules, counsel sign-off. |
| UBO-04 | Threshold-only identification | High | Only holders above 5% are disclosed even though another person exercises ultimate control. | Reconcile the 5% shareholder schedule with an all-control UBO analysis. | UBO memo showing ownership and control tests. |
| UBO-05 | NewWave Holdings ambiguity | Critical | Public parent-company reference is treated as proof of ownership without current records. | Verify exact relationship and effective ownership/control dates. | Group structure chart, intercompany records, registry evidence, current share register. |
| UBO-06 | Nominee or trustee opacity | Critical | Nominee holder is listed but nominator, settlor, trustee, protector, or beneficiary is not traced. | Enhanced legal-entity and trust review. | Nominee/trust documents and natural-person identification. |
| UBO-07 | PEP exposure | Critical | UBO or close associate is a PEP and enhanced controls are not applied or disclosed. | PEP screening at onboarding and before filing, with documented disposition. | Screening result, rationale, EDD, senior approval, ongoing-monitoring plan. |
| UBO-08 | Sanctions/adverse media exposure | Critical | UBO or related entity is sanctioned, investigated, convicted, or subject to adverse regulatory history. | Multi-jurisdiction screening and legal review. | Search methodology, dated results, case disposition, escalation record. |
| UBO-09 | Source-of-wealth gap | Critical | Declared wealth cannot be linked to credible documentary evidence. | Risk-based source-of-wealth verification. | Tax/financial/corporate sale/dividend/investment evidence as appropriate. |
| UBO-10 | Source-of-funds gap | Critical | Capital or test funding cannot be traced to the UBO or legitimate institutional source. | Funds-flow map and independent Finance/Compliance approval. | Bank evidence, funding agreements, transaction trail, CFO/MLRO certification. |
| UBO-11 | Stale information | High | Ownership changed after the evidence date or before submission. | Freshness standard and closing-date confirmation. | Registry search and signed no-change certificate dated near filing. |
| UBO-12 | Conflicting records | Critical | Cap table, registry extract, board records, and application answers disagree. | Reconciliation control with exception log; no submission while unresolved. | Reconciliation worksheet and reviewer sign-off. |
| UBO-13 | Identity-document misuse | Critical | Identity documents are copied to insecure locations or attached to the wrong person. | Secure evidence store, access controls, encryption, document-to-person matching. | Access log, hash manifest, controlled submission record. |
| UBO-14 | Privacy and cross-border transfer | High | US-based or third-party systems move UBO personal data without lawful basis or safeguards. | DPO review, minimisation, retention and cross-border transfer assessment. | Privacy impact assessment, DPA, access policy, retention schedule. |
| UBO-15 | Reviewer conflict | High | Person who supplied or benefits from the structure approves their own evidence. | Segregation of duties and independent review. | Owner/reviewer matrix, attestation, immutable audit record. |
| UBO-16 | UBO-to-governance conflict | High | UBO, board member, MLRO, treasury approver, or release signer has an undisclosed conflict. | Cross-reference UBOs with officer, shareholder, vendor, and approval rosters. | Conflict declarations, recusal register, governance validator output. |
| UBO-17 | False “no UBO” conclusion | Critical | Search stops prematurely or relies on public records alone. | Documented reasonable-measures investigation and counsel conclusion. | Search log, source list, escalation decisions, signed conclusion. |
| UBO-18 | Evidence tampering | High | Digest, issue date, version, or document content changes after review. | SHA-256 manifest, immutable/WORM storage, release binding. | Hash manifest, WORM retention proof, E-09 independent review. |
| UBO-19 | Sanctions-screening time gap | High | UBO was clear at collection but becomes sanctioned before submission. | Re-screen immediately before submission and at test entry. | Timestamped pre-submission and pre-entry screening results. |
| UBO-20 | Unauthorised disclosure | High | Sensitive UBO data is placed in Git, email, slides, or public application artifacts. | Data classification and redaction policy. | Repository scan, distribution list, secure upload receipt. |

## 5. Minimum UBO evidence package

| Package component | Required content | Acceptance test |
| --- | --- | --- |
| Entity identity | Exact legal name, jurisdiction, registration number, status, registered address, and entity role in the proposed service. | Matches certificate, current registry extract, board resolution, and application. |
| Ownership chart | Every direct and indirect owner, parent, subsidiary, affiliate, intermediate company, and control relationship. | No unexplained edge; each company node traces to authoritative evidence. |
| 5% shareholder schedule | Full name/entity, nationality, percentage, share type, registration/BVN field as applicable, residence, and effective date. | Reconciles to issued-share capital and share register. |
| UBO register | Natural person, date of birth, nationality, residence, ownership/control percentage or basis, and effective date. | All control paths independently reviewed. |
| Identity evidence | Valid identification and issuing authority for each UBO. | Name, document number, issue/expiry and person match; stored securely. |
| Control-rights evidence | Voting agreements, appointment rights, veto rights, financing, trusts, nominees, or contractual control. | Legal review confirms whether each right creates ultimate control. |
| Wealth and funds | Source of wealth and source of funds for each relevant UBO and funding entity. | Finance and MLRO approve documentary chain. |
| PEP and sanctions | PEP, close-associate, sanctions, enforcement, criminal, and adverse-media checks. | Dated search, methodology, disposition, escalation where needed. |
| Related interests | Other companies, directorships, partnerships, fiduciary roles, and material related parties. | Cross-checked against conflicts and vendor/partner records. |
| Freshness certificate | Confirmation that no material ownership/control change occurred after the evidence date. | Signed near final submission and again before test entry. |
| Review/audit trail | Evidence owner, independent reviewer, approval date, hash, version, and release binding. | E-09 reviewer confirms integrity and segregation. |

## 6. Comprehensive transition checklist

### Gate A — Legal entity and perimeter

- [ ] Confirm the exact applying legal entity and whether it is NewWave Telecom and Technologies, Inc., NewWave Holdings, LLC, a Nigerian subsidiary, or another entity.
- [ ] Obtain current certificate of incorporation and authoritative registry extract.
- [ ] Confirm registered office, principal place of business, official email, telephone, and authorised signatory.
- [ ] Document the Nigerian connection, local entity, local representative, sponsor, partner, or customer model.
- [ ] Obtain Nigerian counsel memorandum addressing CBN VASP Track, SEC interface, payments activity, custody, exchange, token issuance, and cross-border operation.
- [ ] Confirm the product boundary and exclude any unapproved custody, issuance, exchange, brokerage, retail, or final-settlement activity.

### Gate B — Ownership, UBO, and governance

- [ ] Obtain a current signed ownership chart from the applying entity through all direct and indirect entities to natural-person UBOs.
- [ ] Reconcile the chart to the current share register, cap table, registry extracts, shareholder agreements, trust/nominee records, and voting arrangements.
- [ ] Complete the DEC form’s 5% shareholder table.
- [ ] Complete all UBO biographical fields and effective dates.
- [ ] Collect valid identification for every UBO through the secure submission process.
- [ ] Document every non-equity control right and any person exercising influence through contract or governance rights.
- [ ] Complete source-of-wealth and source-of-funds evidence and funding-flow reconciliation.
- [ ] Complete PEP, sanctions, adverse-media, enforcement, criminal, and regulatory-history screening.
- [ ] Complete other-company interests and related-party mapping.
- [ ] Obtain board approval, authorised-signatory mandate, organogram, board CVs, senior-management CVs, and fit-and-proper declarations.
- [ ] Populate the six accountable UmojaFlowOS governance roles with twelve globally distinct primary and alternate subjects.
- [ ] Verify independent MLRO/CCO reporting to the Board or Risk/Audit Committee.
- [ ] Complete conflict declarations, recusal rules, owner/reviewer segregation, and approval matrices.

### Gate C — Financial and regulatory standing

- [ ] Complete existing licence and registration table.
- [ ] Provide prior CBN Sandbox application history and outcomes.
- [ ] Complete sanctions, enforcement, investigation, conviction, and declined-licence disclosures for applicant, related parties, directors, senior management, and key function holders.
- [ ] Provide authorised and paid-up share capital.
- [ ] Provide liquid assets, monthly operating expenditure, runway, and customer-asset coverage position.
- [ ] Provide three years of audited financial statements or the required management accounts.
- [ ] Provide audit-firm details, current-year projections, and CFO certification.
- [ ] Provide recent three-month bank statements through the secure portal.
- [ ] Ensure all financial figures reconcile across the form, business plan, and financial model.

### Gate D — Product and sandbox design

- [ ] Select only the VASP activity categories that the product will actually test.
- [ ] Describe the product, target users, market problem, benefit, and closest comparables.
- [ ] Attach project plan, detailed business proposal, architecture, data-flow, and independent test results.
- [ ] Define test duration, geography, participant eligibility, volunteer consent, and customer communications.
- [ ] Define maximum single transaction value, daily transaction volume, monthly active users, cash limits, and asset exposure.
- [ ] Define success KPIs, failure thresholds, pause conditions, complaints SLAs, and refund/remediation arrangements.
- [ ] Obtain Product Risk and Treasury approval for all limits.
- [ ] Attach a signed wind-down and exit plan, including reconciliation and evidence preservation.

### Gate E — AML/CFT/CPF and Travel Rule

- [ ] Approve the AML/CFT/CPF policy and risk assessment.
- [ ] Appoint MLRO, CCO, CISO, and DPO where required; provide CVs, qualifications, and fit-and-proper declarations.
- [ ] Document independent reporting line and Board/Risk/Audit oversight.
- [ ] Define KYC tiers, CDD, EDD, PEP, sanctions, source-of-funds, source-of-wealth, and beneficial-ownership procedures.
- [ ] Define transaction-monitoring scenarios, alert handling, escalation, case management, and STR/SAR process.
- [ ] State target STR/SAR submission time and historical filing count accurately.
- [ ] Define record retention, auditability, and access controls.
- [ ] Provide Travel Rule procedure, provider assessment, originator/beneficiary data handling, and exception treatment.
- [ ] Address cross-border transactions, DeFi, smart contracts, mixers, privacy-enhancing tools, and high-risk jurisdictions if relevant.
- [ ] Perform an independent compliance readiness review and remediate all critical findings.

### Gate F — Technology, cyber, privacy, and third parties

- [ ] Attach current system architecture and data-flow diagrams.
- [ ] Demonstrate Keycloak/OIDC, RBAC, MFA, mTLS, privileged-access review, and audit logging.
- [ ] Demonstrate fail-closed behavior for identity, screening, Travel Rule, ledger, reconciliation, approval, evidence, and monitoring failures.
- [ ] Provide current penetration-test report, vulnerability register, remediation evidence, and independent assessment.
- [ ] Document encryption, key management, backup, restore, BCP, DR, RTO, RPO, incident response, and crisis communications.
- [ ] Document wallet, custody, multisignature, KMS/HSM, and customer-asset controls or formally evidence non-applicability.
- [ ] Complete DPO privacy impact assessment, data map, lawful-basis analysis, cross-border transfer controls, retention, deletion, and data-subject handling.
- [ ] Identify all material providers and partners, contracts/LOIs, SLAs, data locations, concentration risks, due diligence, and exit alternatives.
- [ ] Confirm secure WORM/evidence-store operation and E-09 tamper verification.

### Gate G — Evidence, approval, and filing

- [ ] Replace every synthetic fixture, placeholder, sample URI, test subject, and fictional digest with a real verified record or remove the claim.
- [ ] Execute real E-01 through E-08 evidence collection in the approved staging environment.
- [ ] Store evidence in the approved encrypted immutable store; keep secrets and identity documents out of Git.
- [ ] Build the release manifest with E-01 through E-09 artifact IDs, paths, SHA-256 digests, and run IDs.
- [ ] Bind the manifest to the exact release SHA.
- [ ] Perform independent E-09 review by a person who did not own or produce the evidence.
- [ ] Obtain four distinct release approvals: Release Manager, Security Owner, Compliance Owner, and Operations Owner.
- [ ] Obtain additional Legal, Finance, Product Risk, MLRO, DPO, and Board approvals where applicable.
- [ ] Run the dossier, governance, manifest, digest, duplicate-subject, placeholder, and no-fabricated-evidence validators.
- [ ] Verify all application answers reconcile to the attachment register.
- [ ] Review the final cover letter and have it signed by the authorised signatory.
- [ ] Confirm the official CBN portal and email route, recipient, file size, naming, and submission deadlines directly before filing.
- [ ] Record the secure upload receipt and preserve the submitted package immutably.
- [ ] Do not describe sandbox admission as a licence.

## 7. Final GO criteria

The application can move from **DRAFT/NO-GO** to **ready for submission** only when all of the following are true:

1. The applying entity, Nigerian connection, and CBN/SEC regulatory perimeter are documented and approved by counsel.
2. The complete ownership and control chain to natural-person UBOs is evidenced, reconciled, screened, and independently reviewed.
3. No unresolved critical UBO, PEP, sanctions, enforcement, source-of-funds, or ownership-reconciliation exception remains.
4. Board authority, authorised signatory, governance officers, independent compliance reporting, and segregation of duties are evidenced.
5. The product boundary, VASP categories, test limits, participant controls, consumer safeguards, and exit plan are approved.
6. AML/CFT/CPF, CDD/EDD, Travel Rule, privacy, cyber, third-party, resilience, and financial-capacity evidence is complete.
7. E-01 through E-09 evidence is real, release-bound, hash-verified, immutable, and independently reviewed.
8. All four independent release approvals and all required internal approvals are present and distinct.
9. The final form and attachments contain no placeholders, synthetic facts, unsupported claims, or mismatched dates and figures.
10. The authorised signatory confirms that the final package is accurate, complete, current, and ready for filing.

## 8. Decision

**Current decision: NO-GO.** The most urgent blockers are UBO/entity verification, Nigerian regulatory-perimeter analysis, ownership-chain reconciliation, UBO screening and source-of-funds evidence, board/signatory authority, financial capacity, compliance-officer appointments, test-limit approval, and real staging evidence. Public NewWave information can support the introductory company narrative, but it cannot satisfy these submission controls.

## References

[1]: https://sandbox.cbn.gov.ng/ "CBN Regulatory Sandbox Cohort 2 official portal"
[2]: https://www.cbn.gov.ng/ "Central Bank of Nigeria official website"
[3]: https://newwave.io/about-us/ "NewWave About Us"
[4]: https://newwave.io/leadership-team/ "NewWave Leadership Team"

**Primary supplied documents:** `CentralBankofNigeriaRegulatorySandboxFramework.pdf` and `DEC-responses.pdf`.
