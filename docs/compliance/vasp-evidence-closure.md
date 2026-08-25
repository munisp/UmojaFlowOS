# UmojaFlowOS 58-Point Evidence-Closure Programme

**Status as of 2026-08-25:** **0 / 58 independently verified external points.** No VASP dossier or assurance-register item exists in the local development database, and the deployed platform has not received the implementation patch. The programme below defines the evidence that must be acquired before each point can be marked `externally_verified`.

> **Control principle.** Do not upload a document merely to make a register look complete. Each item must be traceable to an accountable owner, stored at an HTTPS evidence location, SHA-256 hashed, independently attested, and verified by a different platform user subject. The resulting status remains evidence verification—not CBN admission, licensing, or approval.[1]

## A. Immediate prerequisites before any point can close

| Sequence | Responsible party | Required output | Register effect |
|---:|---|---|---|
| 1 | Deployment/change owner | Apply the validated P0–P3 patch to a segregated staging environment; retain immutable build digest, migration output, rollback result, and change approval. | Creates a trustworthy environment; does not award a point. |
| 2 | Company secretary/legal owner | Create/select the Nigeria VASP sandbox dossier in the authenticated Sandbox workspace. | Allows the administrator to initialise the six 58-point records. |
| 3 | Administrator | Initialise the readiness assurance register. | Creates six `open` records; **0 points awarded**. |
| 4 | Evidence owner for each area | Upload controlled artifact to the approved HTTPS evidence repository; calculate SHA-256; record URI/digest through the Compliance workflow. | Moves one item to `evidence_recorded`; **0 points awarded**. |
| 5 | Independent reviewer/auditor | Issue or retain external attestation; use a different user subject to verify it in the Sandbox workspace. | Moves one item to `externally_verified`; awards only its fixed point value internally. |

## B. Evidence package 1 — Controlled live test (7 points)

| Requirement | Minimum artifact set | Independent verifier acceptance test | Owner |
|---|---|---|---|
| Defined test perimeter | Signed test plan specifying product, customer type, jurisdictions, excluded features, duration and start/stop criteria. | Plan is consistent with the actual deployed configuration; it does not promise unrestricted operation. | Product and risk owner |
| Bounded exposure | Versioned transaction count, per-customer, aggregate exposure, velocity and corridor limits; test configuration export. | Limits are technically enforced and cannot be changed by a test participant. | Treasury/platform owner |
| Sandbox interoperability | Provider sandbox acceptance artifact, TigerBeetle test-cluster evidence, screening test results and webhook/reconciliation traces. | Evidence contains real controlled test identifiers, timestamps and expected failure paths. | Engineering/provider contact |
| Wind-down | Tested suspension, export, reconciliation and residual-data/wallet process. | Demonstrates an actual test, including exception handling and accountable approval. | Risk/operations owner |

## C. Evidence package 2 — Governance, legal and ownership (8 points)

| Requirement | Minimum artifact set | Independent verifier acceptance test | Owner |
|---|---|---|---|
| Legal entity and ownership | Incorporation record, current ownership/UBO schedule, Nigeria connection and authorised signatory evidence. | Document dates, legal names and ownership records are internally consistent and attributable. | Company secretary/legal counsel |
| Accountable officers | Board/management appointment record for compliance/MLRO, security, product/risk, treasury/custody and consumer protection responsibilities. | Named people have defined authority, alternates and conflict/recusal arrangements. | Board/company secretary |
| Policies and approvals | Board-approved AML/CFT/CPF, privacy, safeguarding, outsourcing, incident, customer protection, BCP/DR and controlled-test policies. | Each policy has version, owner, approval date, review date and evidence of applicable training. | Policy owners/board |
| Access governance | Privileged role roster, MFA enrolment, access review and departed-user review evidence. | Reviewer confirms actual identity provider users/roles match the roster. | Security owner/independent auditor |

## D. Evidence package 3 — AML/CFT/CPF and Travel Rule operations (14 points)

| Requirement | Minimum artifact set | Independent verifier acceptance test | Owner |
|---|---|---|---|
| Programme and MLRO | Approved AML/CFT/CPF programme, enterprise risk assessment, MLRO appointment and escalation matrix. | Programme applies to actual products/corridors and has accountable, trained staff. | MLRO/legal counsel |
| Lawful screening capability | Provider agreement/entitlement, data-processing basis, sanctions/PEP/adverse-media/chain-analysis scope, system test evidence. | Contract and configuration cover test use; screening outcomes include source/version/reference. | MLRO/privacy/provider contact |
| Case operations | De-identified test cases covering clear, hit, false positive, escalation, disposition and retention. | Separate reviewer decisions and time-stamped case history can be reconstructed. | Compliance owner/independent auditor |
| Travel Rule | Approved counterparty/participant evidence, secure schema, exception/rejection handling and no-production-data test trace. | No transmission occurs until a legally approved counterparty/test scope exists. | MLRO/provider contact |
| Reporting decision process | SAR/STR decision policy, authorised signatory, notification clock, secure retention and dry-run record—not a fabricated filing. | Independent review confirms no claim of external filing without an authoritative receipt. | MLRO/CBN liaison |

## E. Evidence package 4 — Customer-asset safeguarding (13 points)

| Requirement | Minimum artifact set | Independent verifier acceptance test | Owner |
|---|---|---|---|
| Product/custody scope | Approved asset/product matrix that states whether custody, wallets, stablecoins, reserves or redemption apply. | Claims match actual features; irrelevant controls are explicitly excluded rather than assumed. | Product/legal/custody owner |
| Key and wallet management | Architecture, key ceremony/rotation, access logs, recovery policy, HSM/MPC evidence where applicable and independent review. | No single operator can misuse customer asset keys; recovery is tested and documented. | Custody security owner |
| Segregation and reconciliation | Customer/provider/ledger reconciliation reports, break handling, separation of client/firm assets, threshold/exception evidence. | Reconciliation uses real controlled records and breaks are independently reviewed. | Treasury/custody/auditor |
| Reserve/redemption/wind-down | Reserve attestation methodology, redemption process, liquidity evidence and orderly exit plan where stablecoin/customer asset scope applies. | Evidence is scope-appropriate and externally attributable; not a source-code claim. | Treasury/legal/independent assurance |

## F. Evidence package 5 — Cybersecurity and operational resilience (10 points)

| Requirement | Minimum artifact set | Independent verifier acceptance test | Owner |
|---|---|---|---|
| Production identity and secrets | Named-admin MFA completion, identity access review, secret-manager configuration, certificate inventory and rotation evidence. | A verifier observes actual staging identity, not only the realm JSON template. | CISO/platform owner |
| Security testing | Scope-authorised vulnerability scan, independent penetration-test report, remediation tracker and retest. | Findings include severity, owner, remediation evidence and residual-risk acceptance. | CISO/independent security assessor |
| Detection and response | WAF/OPA policy evidence, security monitoring/SIEM/on-call evidence, incident escalation and tabletop/technical exercise. | Alerts are exercised from controlled events through attributable response. | Security/SRE owner |
| Continuity and capacity | Backup restore output, DR/failover exercise, RTO/RPO evaluation, 30–90 days SLO samples and capacity/load evidence. | Evidence is from the deployed controlled environment and failure/restore paths are shown. | SRE/independent auditor |

## G. Evidence package 6 — Consumer protection, incident and reporting (6 points)

| Requirement | Minimum artifact set | Independent verifier acceptance test | Owner |
|---|---|---|---|
| Consumer disclosures and complaints | Versioned disclosures, acceptance workflow, complaint process, de-identified complaint test and SLA evidence. | The customer journey, remedy/escalation and records are demonstrably usable. | Consumer-protection owner |
| Incident process | Classification matrix, severity clock, role assignment, communication templates, executed tabletop/technical exercise and post-incident review. | Clock and escalation were tested with timestamps; no false external-notification assertion. | Incident commander/CBN liaison |
| Reporting channel | Written authority/entitlement, secure channel configuration, authorised signer and controlled test receipt. | Receipt is attributable to the intended official channel; it is not merely an HTTP success response. | CBN liaison/legal/compliance |

## H. Residual technical blockers

No new source-code blocker was identified in the local implementation. The actual blockers are deployment and evidence prerequisites: the current deployment has no P0–P3 patch, no staging change window has been provided, no VASP dossier has been created, no evidence record exists, and no independent verification identity or external attestation has been supplied. Provider, screening, TigerBeetle and regulatory flags must remain disabled until their separate approval prerequisites are met.

## I. Evidence acceptance standard

An item may be independently verified only when the reviewer can answer **yes** to all questions below.

| Test | Required answer |
|---|---|
| Scope | Does it apply to the approved product/corridor/test population? |
| Attribution | Is the issuer/owner named and authorised, and is the artifact dated/versioned? |
| Integrity | Does the stored SHA-256 digest match the exact HTTPS artifact? |
| Operation | Does it demonstrate a real exercised control or a formally approved document, as appropriate? |
| Independence | Is the platform verifier a different authenticated subject from the evidence submitter? |
| Truthfulness | Does the evidence avoid claiming CBN admission, licensing, settlement, provider activation or regulatory acceptance without an authoritative external record? |

## Reference

[1]: https://sandbox.cbn.gov.ng/ "Central Bank of Nigeria Regulatory Sandbox"
