# CBN Regulatory Sandbox Cohort 2 — UmojaFlowOS Alignment and Gap Assessment

**Assessment date:** 19 August 2026  
**Scope:** Nigeria (NGN) only; this is an engineering-control assessment, not legal advice, an eligibility determination, or a CBN application.

## Conclusion

UmojaFlowOS is **substantively aligned with the purpose** of the CBN’s Cohort 2 **VASP Track**: it is designed for controlled, evidence-led payment, stablecoin, custody-adjacent, compliance, reporting, and data-enabled operations in Nigeria (NGN). Its USDC/USDT-only stablecoin boundary, mandatory provider verification, fail-closed risk decisions, manual KYC/KYB disposition, audit evidence, CBN report-pack drafting, and prohibition on asserting settlement or regulatory submission without authoritative evidence are directly consistent with responsible supervised testing.

It is **not yet an application-ready or live-test-ready participant**. The platform does not claim admission, licensing, CBN approval, provider activation, customer-fund custody, live execution, regulatory submission, or final settlement. Those claims would be incorrect until a legally incorporated applicant, authorised counterparties, CBN-approved testing parameters, an approved supervised-test plan, and the required external technical and control evidence exist.

> Admission to the CBN Sandbox does not constitute a licence or permission to operate beyond the parameters CBN approves. UmojaFlowOS must retain that boundary in every operator and stakeholder workflow. [1]

## Track fit

| Cohort 2 scope | UmojaFlowOS alignment | Assessment |
| --- | --- | --- |
| VASP Track: stablecoins, payment tokens, wallets, custody, fiat on/off-ramp, payment and settlement infrastructure | The platform scopes stablecoin evidence to **USDC and USDT** and Nigeria (NGN), Kenya (KES), and South Africa (ZAR). It has a Yellow Card RFQ/webhook boundary, provider-neutral onboarding, and activation gates. The Nigeria (NGN) proposition is closest to the VASP Track. | **In scope, but inactive.** |
| Non-VASP Track: permissioned data sharing, payments, fraud/risk analytics, consumer outcomes | The TypeScript control plane, Rust risk core, Python reporting/analytics, governed lakehouse, document-intelligence workflow, and data-minimised evidence path can support data-enabled capabilities. | **Adjacent / potentially in scope** if presented as a distinct Nigeria data-enabled proposition. |
| Controlled real-user testing | The platform can represent drafts, policy outcomes, evidence, and activation gates, but it does not yet represent a CBN-approved sandbox cohort, test population, exposure cap, time window, or admission terms. | **Gap.** |

## Requirement-by-requirement assessment

| Official Cohort 2 requirement | Current UmojaFlowOS evidence | Status | Gap or constraint |
| --- | --- | --- | --- |
| Working MVP, assessed risks, testing readiness, and clear success measures | The managed suite has 561 passing tests; Go, Rust, Python, TypeScript, canonical PostgreSQL, Temporal, Permify, Kafka/Dapr/Fluvio, and Redis controls are implemented and tested. | **Partial** | A deployable MVP exists, but a CBN-specific test plan, approved test boundaries, user segments, success criteria, expected volumes, and exit criteria are not yet recorded. |
| AML/CFT/CPF, CDD, sanctions screening, transaction monitoring, and compliance oversight | Fail-closed Rust policy/monitoring, KYC/KYB consent and human-review workflow, counterparty licensing evidence, compliance cases, SAR/STR records, and transaction-monitoring evidence exist. | **Partial** | Current sanctions, KYC, Travel Rule, provider, and reporting inputs remain activation-gated. A named MLRO/compliance-officer appointment and applicant-level AML/CFT evidence package are not represented as CBN-sandbox dossier evidence. |
| Consumer safeguards: onboarding, disclosure, complaints handling, consumer-harm controls | Consent, document review, compliance cases, access control, policy refusal, duplicate prevention, and role-attributed activity evidence exist. | **Partial** | No structured consumer-disclosure acceptance, complaint lifecycle, complaint outcome, or CBN sandbox consumer-harm reporting package exists. A compliance case is not a substitute for a consumer complaint. |
| Defined testing limits: user categories, volume, customer exposure, duration | Provider activation and policy checks are fail-closed; no code activates a provider without verified prerequisites. | **Gap** | There is no CBN-specific immutable test-parameter record or enforcement of user, volume, exposure, duration, or permitted-use limits. |
| Material incident notification: cyber, fraud, or consumer harm | Service health history, operational alerts, append-only activity evidence, and audit records exist. | **Partial** | No structured incident register with materiality, regulator-notification deadline, delivery evidence, and acknowledged official submission channel exists. |
| Cybersecurity: security policy, controls, testing, vulnerability management, incident response | Credential references are never accepted in browser fields; secret-material guard, Keycloak/JWKS, APISIX/open-appsec configuration, fail-closed service contracts, and strict evidence boundaries are implemented. | **Partial** | Penetration-test reports, vulnerability-management evidence, cyber governance, and an approved incident-response playbook must be supplied and reviewed. Provisioned APISIX/open-appsec remains external. |
| Data protection and privacy governance | Consent-backed KYC/KYB processing, no document bytes in PostgreSQL, S3 references, redacted lakehouse policy, and identifier/credential rejection exist. | **Partial** | There is no applicant-level DPO appointment, processing-register evidence, DPIA record, or CBN-sandbox data-governance dossier. |
| Operational resilience, business continuity, orderly wind-down | Temporal workflow, append-only service health, retry boundary, canonical PostgreSQL, idempotent events, and failure-safe provider gating are implemented. | **Partial** | No approved business-continuity, disaster-recovery exercise, orderly wind-down plan, or test-termination control package is represented. |
| VASP/stablecoin governance, reserves, attestations, redemption, liquidity | USDC/USDT exposure observation, Decimal-based reconciled exposure, treasury positions, liquidity buffers, Yellow Card RFQ boundary, and counterparty lifecycle evidence exist. | **Partial** | No reserve-attestation evidence, issuer redemption terms, stablecoin governance package, or independently verified reserve arrangement exists. The platform must not infer reserves from exposure observations. |
| Customer funds/assets safeguards, segregation, custody/wallet/key management | PostgreSQL models custody-wallet positions; the Go TigerBeetle path is activation-gated; the Rust gateway validates balanced posting sets. | **Partial** | A custody operating model, asset-segregation evidence, wallet architecture, hot/warm/cold allocation, signing/key-management controls, and an activated TigerBeetle environment are external prerequisites. |
| Regulatory reporting and prompt submission evidence | CBN report packs are assembled and validated from canonical source records; reporting cannot be marked submitted without an authorised channel reference. | **Partial** | The CBN sandbox reporting schema, cadence, portal submission channel, and authorised submitter must be confirmed. No report or incident is currently represented as submitted. |
| Corporate, ownership, governance, financial-resource, and third-party documentation | Counterparty legal onboarding and regulator/authorisation evidence exist; provider activation requires licensed counterparty evidence. | **Partial** | The applicant entity’s incorporation, directors, UBOs, source of funds, corporate approvals, financial capacity, third-party contracts, and governance documents have not been provided and cannot be fabricated. |

## Material gaps that should be implemented before an application package is assembled

The following are **provider-independent platform gaps** and can be addressed in the control plane without claiming that a person, document, CBN approval, or technical assessment exists:

1. A CBN Sandbox Cohort 2 application workspace that records a draft applicant dossier, selected track, and immutable evidence references without allowing a claim of submission or admission.
2. A controlled-test plan with enforced user-category, transaction-count, aggregate-exposure, duration, and permitted-use boundaries; it must stop a test rather than silently allow a live-payment workflow.
3. Structured consumer disclosure/acceptance, complaints, material-incident, and orderly-wind-down records. External regulator notification must remain pending until an approved official channel confirms it.
4. A CBN VASP readiness checklist for governance, beneficial ownership, AML/CFT/CPF, consumer protection, cyber assessment, privacy/DPO, business continuity, test evidence, reserve governance/attestation, redemption, custody/wallet/key management, asset segregation, and third-party oversight. The checklist must show **missing** where no evidence exists; it must not synthesize a pass.
5. A CBN sandbox reporting evidence pack that gathers only accepted controlled-test records and cannot mark external submission complete absent a CBN reference.

## External gates that code cannot close

The CBN application itself requires an eligible legal entity and evidence that the platform does not possess. These remain external: corporate registration and board approvals; shareholders/UBOs/source-of-funds disclosures; named MLRO/compliance, risk, technology, cybersecurity, and DPO personnel; applicant financial-resource evidence; third-party agreements; CBN portal submission; CBN-approved testing parameters; provisioned middleware; licensed and credentialed providers; formal penetration-test and continuity-test evidence; reserve attestations; custody/key-management evidence; and official CBN incident/reporting channels.

## References

[1] [CBN Regulatory Sandbox — Cohort 2](https://sandbox.cbn.gov.ng/)

The detailed source observations, including the official-site PDF access limitation, are retained in `docs/cbn-cohort-2-source-notes.md`.
