# CBN-Relevant Value, VASP Maturity, and Innovation Roadmap

_Updated 20 August 2026. This assessment is a technical product review, not legal advice, a regulatory submission, an assertion of CBN or SEC endorsement, or a representation that UmojaFlowOS or a platform user holds a licence._

## Executive assessment

UmojaFlowOS is most mature as a **provider-independent VASP control plane**, rather than as an operating VASP, exchange, custodian, payment institution, or regulatory filing channel. It provides a canonical PostgreSQL evidence model, role-attributed review, append-only activity records, controlled dossier and incident records, counterparty readiness gates, Travel Rule readiness evidence, and deliberately non-executable Go, Rust, Python, and TypeScript contracts. It does **not** claim regulatory admission, bank-account access, custody authority, provider activation, Travel Rule transmission, stablecoin movement, payment execution, settlement, or regulatory submission.

The distinction is material. Nigeria’s SEC describes ARIP as a controlled pathway for VASPs that includes governance, AML/CFT/CPF, Travel Rule, reporting, inspection, incident, consumer-protection, and transition expectations.[1] FATF likewise expects VASPs to conduct customer due diligence, keep records, report suspicious activity, and securely transmit required originator and beneficiary information; it identifies material gaps in Travel Rule implementation and heightened stablecoin illicit-finance risk.[2] [3] UmojaFlowOS can make the evidence, review, and audit processes for those obligations demonstrable. A licensed regulated entity and approved counterparty network must still perform the regulated activity.

## Value to CBN and the Nigerian supervisory ecosystem

> UmojaFlowOS is valuable to CBN and related supervisory stakeholders **only as a controlled evidence and risk-orchestration layer**. It cannot replace CBN, SEC Nigeria, NFIU, an authorised bank, an approved VASP, or a statutory filing channel.

| Supervisory benefit | Implemented platform contribution | Hard boundary |
|---|---|---|
| Better readiness visibility | A Nigeria (NGN) VASP dossier can retain corporate, AML/CFT/CPF, cybersecurity, consumer-protection, operational-resilience, stablecoin, custody-key-management, and testing evidence. | Internal completeness is not CBN/SEC eligibility, approval-in-principle, registration, licence, or sandbox admission. |
| Stronger review traceability | Role-gated evidence intake, reviewer rationale, immutable activity records, assessment outcomes, incidents, complaints, and reporting-pack manifests are kept in canonical PostgreSQL. | No automatic report delivery, notification, or regulator API submission occurs. |
| Safer cross-border policy operations | Nigeria (NGN), Kenya (KES), and South Africa (ZAR) corridor policies retain regulator context for CBN, CBK, and SARB, alongside counterparty and stablecoin-route prerequisites. | The platform does not determine legal permissibility or send funds across a corridor. |
| More credible Travel Rule preparation | The new VASP readiness surface records originator, beneficiary, secure-exchange design, counterparty-identity, and exception-handling evidence, then returns an internal-only outcome. | No beneficiary/originator data are exchanged and no counterparty is verified through this feature. |
| Better systemic-risk discipline | Fail-closed provider gates, controlled-test planning, incident and complaint evidence, Caddy/APISIX/OPA/Keycloak/open-appsec configuration, and deployment preflight reduce the chance that unreviewed integration becomes an operational rail. | External security controls are not active until independently provisioned and approved. |

CBN records that it issued VASP bank-account operating guidance in December 2023 and frames its wider reforms around financial-system stability, AML/CFT/cybersecurity supervision, and early warning.[4] That makes an auditable, non-executable readiness layer useful to a regulated institution or a supervisory-facing team. It does **not** make UmojaFlowOS a supervisory system of record or an authorised VASP bank-account interface.

## Current maturity by capability

| Capability | Current state | Maturity interpretation | Remaining condition before live operation |
|---|---|---|---|
| Supervisory / ARIP dossier readiness | Implemented. The VASP dossier supports controlled evidence, test-plan, incident, consumer, reporting-pack, and new SEC-pathway readiness records. | **Internally mature.** Evidence and role boundaries are implemented and tested. | Counsel-reviewed regulatory strategy; regulator engagement; real documents; verified eligibility; formal approval. |
| AML/CFT/CPF control evidence | Implemented. Evidence categories, compliance cases, alerts, review records, and no-submission reporting artefacts are available. | **Internally mature.** It is a decision-support and evidence layer. | Licensed entity policies, real screening sources, trained reviewers, approved reporting channels. |
| Travel Rule readiness | Implemented. Five evidence categories and append-only route assessments return only internal completeness. | **Readiness mature; operationally gated.** | Validated counterparty identity/licence, interoperable endpoint, secure data-exchange agreement, privacy/legal review, controlled test, and human approval. |
| USDC / USDT governance | Implemented as an evidence and policy boundary. The platform accepts only USDC and USDT in relevant governance workflows. | **Policy mature; execution unavailable.** | Lawful product scope, validated provider/custody/issuer route, liquidity, sanctions/Travel Rule controls, and approvals. |
| Custody / wallet / key management | Evidence category and control prerequisites exist. | **Readiness only.** | Authorised custody provider or independently approved key-management environment, insurance/risk controls, and external authorisation. |
| On-chain monitoring / screening | Contracts and evidence path exist, but third-party activation remains gated. | **Control design available; live intelligence unavailable.** | Approved screening provider, legal basis, data-processing agreements, credentials, and alert operating procedures. |
| Security / resilience | Caddy, APISIX, Keycloak MFA, OPA, open-appsec requirements, Redis, PostgreSQL-only composition, security preflight, and database isolation are implemented. | **Deployment-ready configuration, not live assurance.** | Provisioned environment, secret management, mTLS/TLS material, security-owner approval, penetration testing, monitoring, and incident exercise. |

## Ten VASP innovations

The innovations below are ranked for regulatory value, buyer value, control reuse, and feasibility. “Implemented” means the non-executable control exists in the canonical codebase; it never means that regulated activity is authorised.

| Rank | Innovation | Value and scope | Status and activation prerequisite |
|---:|---|---|---|
| 1 | **Supervisory Pathway Dossier** | Maps an operating model and evidence to SEC ARIP, full-registration, or another documented pathway, including transition/exit evidence. | **Implemented.** Requires counsel review and regulator engagement before any external submission. |
| 2 | **Travel Rule Interoperability Readiness** | Separates data-model, secure-exchange-design, counterparty-identity, and exception-handling evidence from any data transmission. | **Implemented.** Requires an authorised counterparty, approved interoperability method, privacy review, and controlled test before transmission. |
| 3 | **Stablecoin Route Control Map** | Maintains USDC/USDT-only policy evidence, issuer/reserve, redemption, custody, and route controls against each use case. | **Partially implemented.** Requires provider, liquidity, custody, legal, and controlled-test evidence. |
| 4 | **Licence-Scope and Recertification Ledger** | Links counterparty authorisation references, scope, expiry, suspension, and recertification to a route decision. | **Implemented foundation.** Requires independent evidence validation and an approved ongoing-monitoring process. |
| 5 | **Offshore VASP Exposure Register** | Adds jurisdiction, control-gap, beneficial-ownership, and enforcement-risk records for cross-border counterparties. | **Next provider-independent increment.** Requires authoritative licence and jurisdiction data to operate. |
| 6 | **Stablecoin Concentration and Redemption Stress Evidence** | Relates asset concentration, redemption dependency, reserve-attestation evidence, and wind-down triggers to a scenario. | **Existing treasury/stablecoin foundations.** Requires reconciled positions and approved source data. |
| 7 | **Consumer Harm and Disclosure Evidence Register** | Connects disclosures, complaints, remediation decisions, and product-specific risk acknowledgement to supervisory packs. | **Implemented foundation.** Requires approved disclosure and complaint policies. |
| 8 | **Incident-to-Supervisor Decision Clock** | Calculates evidence deadlines from a policy version without auto-notifying a regulator. | **Existing incident/deadline foundations.** Requires a current legally approved notification matrix and authorised delivery channel. |
| 9 | **VASP Control Assurance Scorecard** | Gives executives and reviewers a reproducible gap view across governance, AML/CFT/CPF, cyber, Travel Rule, custody, consumer protection, and resilience. | **Control Assurance Hub foundation implemented.** Requires human ownership of scoring policy and current evidence. |
| 10 | **Privacy-Preserving Supervisory Analytics** | Exports minimal, source-referenced aggregates to the lakehouse for trend review without manufacturing activity data or sharing personal information by default. | **Architecture foundation implemented.** Requires governed data-sharing purpose, retention schedule, and a provisioned lakehouse. |

## Prioritised implementation delivered in this revision

This revision implements innovations 1 and 2 as a complete provider-independent control path. PostgreSQL migration `0035_vasp_regulatory_readiness.sql` adds supervisory profiles, append-only supervisory evidence, append-only Travel Rule evidence, and append-only route assessments. The TypeScript API applies administrator or compliance-officer procedure boundaries. The protected CBN workspace presents stakeholder-readable status and explicit boundaries. Go, Rust, and Python contracts report missing readiness prerequisites while hard-coding all external authority fields to `false`.

Direct protected-workspace browser review in the isolated canonical preview is currently blocked by the intended Keycloak-only configuration boundary: no Keycloak client/issuer configuration or approved test identity has been supplied. The component regression, live PostgreSQL service regression, TypeScript check, and production build validate the source-level integration; a signed-in browser review remains an external identity-environment gate.

## Residual external gates

The following gaps cannot be closed with code alone: legal and regulatory interpretation; an SEC/CBN/NFIU or other official decision; licensed counterparty identity and scope verification; bank, exchange, custody, liquidity, and Travel Rule connectivity; authoritative sanctions/on-chain monitoring data; real customer evidence; policy-owner approval; secure production infrastructure; security assessment; and authorised reporting channels. Any absence or ambiguity must remain a blocked or human-review outcome.

## References

[1]: https://home.sec.gov.ng/about/resources/checklists/accelerated-regulatory-incubation-program-arip-checklist-for-vasp-onboarding/ "SEC Nigeria: ARIP Checklist for VASP Onboarding"
[2]: https://www.fatf-gafi.org/en/topics/virtual-assets.html "FATF: Virtual Assets"
[3]: https://www.fatf-gafi.org/en/publications/Fatfrecommendations/targeted-update-virtual-assets-vasps-2025.html "FATF: 2025 Targeted Update on VAs and VASPs"
[4]: https://www.cbn.gov.ng/AboutCBN/Reforms.html "CBN Reforms and Initiatives"
