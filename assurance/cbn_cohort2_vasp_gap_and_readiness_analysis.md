# CBN Regulatory Sandbox Cohort 2: UmojaFlowOS VASP Gap and Readiness Analysis

**Assessment basis:** Attached CBN Regulatory Sandbox Programme – Cohort 2 call document, pages 1–9, compared with the current UmojaFlowOS repository and assurance records.

**Purpose:** Assess suitability for **CBN Sandbox Cohort 2 VASP-track participation**. This is not a licence opinion, regulatory certification, or approval to operate. The Cohort 2 document expressly states that sandbox participation and successful testing do not automatically confer a licence, authorisation, registration, or entitlement to operate.

## Executive conclusion

UmojaFlowOS is a credible candidate for the **VASP Track** because its stated scope covers virtual-asset payment, settlement, wallet/custody-adjacent infrastructure, compliance monitoring, evidence, and payment-control infrastructure. The strongest fit is not an already authorised exchange or custodian; it is a **provider-independent, activation-gated control plane for governed virtual-asset and stablecoin payment workflows**.

The codebase demonstrates substantial control implementation: Keycloak/Vault identity and secret governance, PostgreSQL canonical migrations, payment/webhook validation, TigerBeetle contracts, reconciliation, AML/compliance evidence boundaries, WORM/audit controls, role separation, release evidence, monitoring, and fail-closed activation. The repository also correctly avoids claiming that a simulator, static configuration, or local test proves a live external integration.

The principal gap is therefore not absence of a broad control design. It is **controlled-live-test readiness and application-package completeness**. Real staging evidence for Keycloak, Vault, TigerBeetle, provider webhooks, AML/sanctions, Travel Rule, WORM, alert delivery, rollback, restore, and chaos recovery is still required. The applicant also needs a specific Nigerian operating model, named accountable legal entity and counterparties, board/management approvals, consumer disclosures and consent, an explicit transaction/exposure test limit, and a viable post-sandbox regulatory pathway.

### Overall assessment

| Assessment | Result |
|---|---|
| VASP-track conceptual fit | **Strong** |
| Code and control-plane maturity | **Strong but conditional** |
| Controlled live-testing readiness | **Partial** |
| Application/documentary readiness | **Partial / not evidenced in repository** |
| External integration proof | **Not proven** |
| Cohort participation recommendation | **Proceed only after closing priority application and staging evidence gaps** |
| Live customer-payment authorization | **NO-GO** |

## CBN criteria used

The attached Cohort 2 call describes a VASP Track for supervised testing of virtual assets and related technologies performing, or intended to perform, payment, settlement, or store-of-value functions, together with supporting infrastructure. It lists examples including fiat-backed stablecoin payment and settlement, stablecoin issuance, virtual-asset payment, wallet infrastructure, custody, token-based payments, on/off-ramp, exchange, compliance/monitoring technology, and payment/settlement infrastructure.

Applicants must demonstrate that the innovation is sufficiently developed for controlled live testing; addresses a market need or clear benefit; identifies and mitigates legal, financial, operational, technological, cyber, and consumer risks; has governance, consumer-protection, data-protection, cybersecurity, and resilience arrangements; has AML/CFT/CPF controls where applicable; has reporting, monitoring, and incident-notification capacity; and can be tested within defined parameters without unacceptable risk. The application assessment also considers submission completeness, eligibility, innovation and market benefit, controlled-testing readiness, alignment with scope, governance/risk/compliance/consumer protection, technical and operational capacity, testing and exit plans, post-sandbox regulatory pathway, financial-system and consumer impacts, and overall suitability.

## Criterion-by-criterion scorecard

The scores below are engineering readiness estimates against the CBN application and testing criteria, not CBN scoring or a prediction of admission.

| CBN assessment criterion | Score | UmojaFlowOS evidence | Gap before cohort submission or live test |
|---|---:|---|---|
| Completeness and accuracy of application | 55/100 | Extensive technical and assurance documents exist, including `assurance/feature_completeness_inventory.md`, `assurance/requirements_traceability.md`, runbooks, release evidence schemas, and sign-off templates. | No completed Cohort 2 application package is evidenced. Add a single authoritative dossier with legal entity, ownership, board approvals, innovation narrative, test parameters, counterparties, financial capacity, and annex index. |
| Applicant and innovation eligibility | 80/100 | The architecture maps naturally to the VASP Track: stablecoin/payment-control infrastructure, compliance monitoring, wallet/custody-adjacent controls, and payment/settlement evidence. | Legal identity, Nigerian deployment structure, licence/registration position, responsible entity, and named licensed counterparties are external facts not established in code. |
| Degree of innovation and market benefit | 75/100 | The control plane addresses governed cross-border payment/settlement workflows, release-bound evidence, reconciliation, audit immutability, role separation, and activation-gated external movement. | The application needs a concise problem statement, target users, Nigeria-specific benefit, measurable baseline, differentiation, and proof that the proposed innovation is materially different or beneficial. |
| Readiness for controlled live testing | 62/100 | Fail-closed provider activation, Keycloak OIDC, Vault rotation, webhook HMAC/replay protection, TigerBeetle contracts, reconciliation states, canary recovery, WORM evidence, and test runbooks are implemented. | Real staging execution is not proven. Complete E-01–E-09, including actual middleware, provider, ledger, alert, rollback, restore, and chaos evidence. |
| Alignment with VASP Track scope | 85/100 | The repository explicitly covers virtual-asset/stablecoin payment boundaries, provider-independent settlement controls, compliance evidence, wallet/custody limitations, and payment infrastructure. | State the exact proposed test product. Avoid presenting the platform as a licensed custodian, exchange, payment institution, IMTO, bank, or settlement network unless separately authorised. |
| Governance, risk, compliance, and consumer protection | 68/100 | Four-role independent sign-off, SoD monitoring, AML/CFT/CPF evidence structures, audit/WORM, role-aware UI, incident paths, complaints-related workflow structures, and fail-closed controls exist. | Produce board/management approvals, named accountable officers, consumer disclosures/consent, vulnerable-customer treatment, complaints SLAs, dispute resolution, privacy notices, risk appetite, and a residual-risk acceptance process. |
| Technical and operational capacity | 65/100 | Multi-language services, canonical PostgreSQL migrations, monitoring, deployment automation, reconciliation, chaos assets, and runbooks exist. | Provide capacity tests, supported transaction volumes, staffing/on-call roster, infrastructure sizing, operational ownership, service-level objectives, backup/restore evidence, and evidence that all required middleware is provisioned. |
| Testing and exit-plan feasibility | 72/100 | E-01–E-09 runbooks, controlled test concepts, rollback, recovery, reconciliation, and evidence manifests are present. | Convert the generic runbooks into a CBN-facing test plan with customer/counterparty categories, maximum counts, transaction/exposure/geographic limits, success metrics, suspension triggers, and a dated exit/transition plan. |
| Post-sandbox regulatory pathway | 42/100 | The repository documents boundaries and avoids asserting licences or regulator submission authority. | This is the largest documentary gap. Define whether the post-test model is licensing, partnership with an authorised institution/VASP, coordinated authority engagement, further supervised development, or discontinuation. Identify CBN and other competent authorities. |
| Impact on consumers, financial stability, monetary sovereignty, and competition | 60/100 | Limit and gate concepts, evidence, reconciliation, AML/CFT boundaries, consumer controls, and stablecoin restrictions are represented. | Add a Nigeria-specific impact assessment covering stablecoin reserve/valuation risk, FX and monetary-sovereignty implications, liquidity, safeguarding, concentration, fraud, consumer loss, systemic spillover, and competition. |
| Overall suitability for CBN Sandbox testing | 65/100 | Strong provider-independent control foundation and explicit refusal to overclaim production capability. | Suitability becomes credible after external staging proof and a complete, bounded, supervised test proposal are assembled. |

### Cohort-readiness score

Using the above criterion weights aligned to the CBN assessment themes, the current estimated cohort-readiness score is **68.9/100, rounded to 69/100**. This score is not an official CBN score. It is a decision aid that applies a severe penalty to unproven external and documentary requirements.

The score supports **conditional application preparation**, not a claim that the application would be admitted. It also does not override the separate production decision: live customer payment remains **NO-GO**.

## VASP feature gap analysis

### 1. Identity, onboarding, and account authority

**Implemented:** Keycloak federation/JWKS checks, audience and issuer validation, role-aware journeys, OIDC-bound service access, Vault-managed rotation, approval subject distinctness, and separation-of-duties controls.

**Assessment:** Strong local implementation. The code has the right boundary for a sandbox participant because it does not treat an internal role as proof of regulatory authority.

**Gap:** Real staging realm/client configuration, revocation semantics, TLS trust, operator identity evidence, customer onboarding consent, beneficial-owner data handling, and the legal entity’s accountable officer are not proven. Cohort submission must include the actual onboarding journey and evidence that no customer becomes active without required checks.

### 2. KYC/KYB and customer/counterparty due diligence

**Implemented:** Evidence-only KYC/KYB boundaries, review-required document/model outputs, provenance controls, counterparty onboarding lifecycle, recertification concepts, and role-bound review paths.

**Assessment:** Moderate-to-strong control foundation.

**Gap:** The repository does not prove production identity-data sources, Nigerian customer segmentation, beneficial ownership workflow, reviewer staffing, SLA, false-positive handling, consent, data-subject rights, retention, or model performance. Any automated model outcome must remain non-decisional unless the approved operating model and evidence support it.

### 3. Virtual-asset/stablecoin payment and settlement

**Implemented:** Stablecoin route evidence, payment-order gates, provider-independent settlement boundary, currency/amount controls, liquidity arithmetic, ledger integration contracts, reconciliation, and explicit refusal to assert settlement without authorised external facts.

**Assessment:** Strong safety boundary; incomplete live product proof.

**Gap:** The application must define whether the test is payment, settlement, on/off-ramp, wallet infrastructure, custody support, or compliance infrastructure. It must identify who legally holds funds/assets, who executes conversion/settlement, reserve or safeguarding arrangements, redemption/withdrawal rules, fees, limits, customer-loss treatment, and counterparty responsibilities.

### 4. Provider execution and webhooks

**Implemented:** HMAC-SHA256 verification, timestamp freshness, replay protection, CIDR enforcement, SSRF controls, endpoint validation, exact payment identity, and reconciliation boundaries.

**Assessment:** High local logic confidence.

**Gap:** No real provider credentials, signing-key rotation evidence, source-range confirmation, retry/order semantics, or provider incident receipt is proven. CBN application evidence should include a provider contract/control matrix and a bounded sandbox endpoint test, not simulator-only output.

### 5. AML/CFT/CPF, sanctions, and transaction monitoring

**Implemented:** Fail-closed screening paths, evidence states, risk/compliance service boundaries, alerting structures, case/audit concepts, and timeout/error handling.

**Assessment:** Partial; this is a critical cohort risk area.

**Gap:** Real screening/sanctions data source, tuning methodology, alert disposition, escalation, suspicious transaction reporting process, CBN/FIU interaction, false-positive controls, analyst access, retention, and controlled-live timeout/failure evidence are absent from the verified runtime scope. The 14 AML/CFT/CPF and Travel Rule evidence items must be populated with real test artefacts.

### 6. Travel Rule and inter-VASP information exchange

**Implemented:** Travel Rule evidence types and gaps appear in control/evidence schemas and route readiness structures.

**Assessment:** Early-to-moderate implementation.

**Gap:** No demonstrated real counterparty exchange, data-field contract, originator/beneficiary handling, unhosted-wallet policy, refusal/hold rules, privacy/security controls, or delivery/retry evidence. This should be a specifically bounded test objective, or excluded from the first cohort experiment with a documented rationale.

### 7. Custody, wallets, and safeguarding

**Implemented:** The repository deliberately keeps custody, wallet, settlement, and value movement behind authorised-provider boundaries rather than pretending the control plane itself is a custodian or wallet operator.

**Assessment:** Strong non-claim and safety posture, but not a custody implementation.

**Gap:** If the proposed Cohort 2 product includes custody or wallet infrastructure, provide key-management architecture, segregation, access quorum, recovery, transaction signing, asset reconciliation, customer statements, safeguarding, insolvency treatment, and incident response. If not, explicitly exclude custody and asset holding from the proposed test.

### 8. Consumer protection and complaints

**Implemented:** Role and evidence workflows, consumer/incident record concepts, retry boundaries, auditability, and refusal-oriented operational paths exist.

**Assessment:** Partial.

**Gap:** The CBN document requires informed consent, risk disclosure, customer exit rights, complaints/dispute resolution, protection of vulnerable customers where relevant, and orderly treatment at termination. These must be assembled as customer-facing documents and tested operationally, not inferred from backend tables.

### 9. Cybersecurity, data protection, and resilience

**Implemented:** Keycloak/Vault, mTLS, RBAC, OPA/Permify patterns, WORM, secret scanning, HMAC, network controls, chaos assets, and incident runbooks.

**Assessment:** Strong design; external runtime evidence missing.

**Gap:** Execute staging penetration/security review, TLS verification, backup/restore, network partition, credential-expiry, alert delivery, RTO/RPO, and incident-notification tests. Provide Nigeria-appropriate privacy/data protection documentation and a data-flow inventory.

### 10. Records, audit, reporting, and regulatory coordination

**Implemented:** Append-only audit concepts, WORM retention, detached signatures, release manifests, reconciliation records, evidence hashes, and reporting assembly boundaries.

**Assessment:** Strong evidence foundation.

**Gap:** The platform does not itself prove an authorised regulatory submission channel. The application needs the reporting calendar, accountable compliance owner, regulator/authority coordination model, record-retention schedule, report approval process, and proof that reports can be produced from immutable records.

## Highest-priority gaps before cohort submission

| Priority | Gap | Closure evidence |
|---|---|---|
| P0 | No complete CBN-facing innovation/test dossier | One versioned dossier with legal entity, ownership, board approval, innovation, test plan, risk register, controls, customer documents, capacity, exit plan, and regulatory pathway |
| P0 | No real controlled-live staging evidence | E-01–E-09 against one immutable release SHA, with real Keycloak/Vault/PostgreSQL/TigerBeetle/provider/WORM/monitoring infrastructure |
| P0 | External provider/licensing/counterparty facts absent | Licensed/authorised partner confirmation, provider scope, credentials, allowlists, contracts, and responsibilities |
| P0 | Consumer protection package not evidenced | Consent, disclosures, fees/risks, complaints, dispute, exit, vulnerable-customer, loss/refund, and termination procedures |
| P0 | AML/CFT/CPF operating evidence absent | Real screening/sanctions controls, alert disposition, escalation, reporting, case retention, and failover evidence |
| P1 | Test boundaries not yet CBN-specific | Maximum customers/counterparties, transaction count/value, exposure, geography, currencies, duration, test cohorts, and suspension triggers |
| P1 | Post-sandbox pathway unclear | Specific licensing/partnership/coordinated-authority route with accountable owners and milestones |
| P1 | Live observability and incident notification unproven | Prometheus/Alertmanager/PagerDuty test receipt, 24-hour incident workflow rehearsal, dashboard evidence, and on-call acknowledgement |
| P1 | Real ledger and reconciliation evidence absent | TigerBeetle cluster, transfer, idempotency, reconciliation, partition/failover, and recovery evidence |
| P2 | Nigeria-specific impact and market analysis incomplete | Stablecoin/FX/monetary sovereignty, systemic, consumer, competition, and inclusion impact assessment |
| P2 | Model and data governance evidence incomplete | Model provenance, capacity, reviewer calibration, drift, privacy, retention, and human-review evidence |

## Required application dossier structure

The Cohort 2 submission should be assembled as one immutable, SHA-bound package with these sections:

| Section | Contents |
|---|---|
| Corporate and regulatory identity | Legal entity, incorporation, ownership, directors, Nigerian presence, existing licences/registrations, accountable officers, and regulatory perimeter analysis |
| Innovation proposition | Problem, users, product boundary, VASP-track category, architecture, novelty, market benefit, Nigerian relevance, and what the platform explicitly does not do |
| Proposed test plan | Objectives, customer/counterparty cohort, volumes, values, limits, geography, duration, currencies/assets, counterparties, success criteria, metrics, and data collection |
| Risk and controls | Legal, financial, operational, technological, cyber, AML/CFT/CPF, sanctions, Travel Rule, consumer, privacy, safeguarding, liquidity, stablecoin, and third-party risk |
| Governance and operating model | Board approval, management oversight, role matrix, four independent approvals, SoD, staffing, training, escalation, on-call, and audit access |
| Consumer package | Consent, disclosures, fees, material risks, complaints, disputes, exit/withdrawal, vulnerable customers, data rights, and termination treatment |
| Technical assurance | Release SHA, SBOM/provenance, architecture, Keycloak/Vault, PostgreSQL, ledger, provider integrations, WORM, monitoring, DR, and security results |
| AML/CFT/CPF and Travel Rule | Policies, screening/sanctions data, case workflow, escalation, reporting, information exchange, refusal/hold rules, and test evidence |
| Exit and transition | Results, residual risks, remediation, customer treatment, long-term regulatory model, licensing/partnership route, data/asset return, and orderly wind-down |
| Evidence index | E-01–E-09 artifacts, hashes, source identities, timestamps, independent reviews, exceptions, and approval payloads |

## Recommended cohort test boundary

For the first controlled test, the lowest-risk proposition is a **limited, non-custodial, provider-independent control-plane pilot** in which:

1. Customers and counterparties are tightly enumerated and consented.
2. Transaction and exposure limits are explicit and small enough to contain loss.
3. UmojaFlowOS does not hold customer funds or virtual assets and does not claim final settlement.
4. A separately authorised/licensed counterparty executes any payment, conversion, custody, or settlement activity.
5. AML/CFT/CPF and sanctions screening occur before the payment-order gate.
6. Travel Rule scope is either implemented against an identified counterparty or explicitly excluded from the first test with CBN agreement.
7. Every external movement has immutable intent, approval, provider response, ledger fact, reconciliation, and incident evidence.
8. The test has automatic suspension triggers for screening outage, reconciliation indeterminacy, ledger consensus loss, provider anomalies, WORM failure, or alerting failure.
9. An exit plan can return or reconcile all customer/counterparty obligations without relying on unverified automation.

## Final recommendation

UmojaFlowOS should **prepare and submit for Cohort 2 consideration only after** the application dossier, accountable legal/counterparty model, customer-protection package, bounded test plan, post-sandbox pathway, and real staging evidence are assembled. The codebase is sufficiently mature to support that preparation and controlled validation, but the repository alone cannot prove the external facts that CBN will need to assess.

The defensible status is:

> **VASP Track fit: strong. Cohort-readiness: conditional, approximately 69/100 on an engineering evidence basis. Production/live customer payment: NO-GO. Recommended next action: close P0 documentary and staging evidence gaps, then obtain independent legal/compliance review before submission.**

## References

[1]: `/home/ubuntu/upload/CBN-Sandbox-CallForApplication-Cohort-2.pdf` — Central Bank of Nigeria, *Call for Applications: CBN Regulatory Sandbox Programme – Cohort 2*.

[2]: `/home/ubuntu/UmojaFlowOS/assurance/feature_completeness_inventory.md` — UmojaFlowOS feature-completeness and trust-boundary inventory.

[3]: `/home/ubuntu/UmojaFlowOS/assurance/requirements_traceability.md` — UmojaFlowOS mission-critical assurance traceability register.

[4]: `/home/ubuntu/UmojaFlowOS/docs/cbn-imto-control-plane-fit.md` — CBN IMTO licence-model and UmojaFlowOS control-plane boundary assessment.

[5]: `/home/ubuntu/UmojaFlowOS/docs/production-completion-readiness.md` — UmojaFlowOS production-completion readiness baseline.
