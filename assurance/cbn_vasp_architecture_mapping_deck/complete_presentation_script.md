# UmojaFlowOS and the CBN VASP Sandbox
## Complete Executive Presentation Script

**Audience:** CBN and other government officials, ministries, financial institutions, business partners, auditors, and prospective system integrators.

**Recommended duration:** 20–25 minutes, followed by 10 minutes of questions.

**Presenter:** Patrick Munis, Founder and CEO, Newwave Technologies.

> **Important framing:** This is an architecture and readiness briefing. UmojaFlowOS is not a banking licence, a VASP licence, a CBN endorsement, or a substitute for regulated financial institutions, legal counsel, or supervisory authority. Any economic figures are scenario estimates, not guaranteed savings or fiscal forecasts.

---

## Slide 1 — UmojaFlowOS and the CBN VASP Sandbox

**Suggested time:** 2 minutes

Good morning and thank you for the opportunity to present UmojaFlowOS.

Today’s discussion is about how a governed operating layer can help Nigeria test responsible virtual-asset and stablecoin use cases while protecting consumers, financial institutions, government, and the integrity of the financial system.

UmojaFlowOS is designed as a single control and evidence fabric. It connects identity, authority, compliance, transaction policy, liquidity, ledger integrity, incident response, reporting, and immutable assurance evidence in one operating model.

The central proposition is simple: an experiment should not be allowed to become a payment merely because a system can technically execute it. The system must first establish who is acting, what is permitted, what risk checks have passed, whether the transaction is within an approved boundary, whether the ledger can reconcile it, and whether the decision can later be independently proved.

This presentation explains the platform in business terms, maps it to the CBN Sandbox mission, and shows what is already implemented locally versus what still requires real organisational evidence and supervised staging validation.

**Transition:** Let us begin with the regulatory purpose that the platform is designed to support.

---

## Slide 2 — What the CBN Sandbox Is Designed to Achieve

**Suggested time:** 3 minutes

The CBN Sandbox exists to create a controlled environment in which financial innovation can be tested without exposing the broader public to uncontrolled risk.

For a VASP-related proposition, that means the applicant must be able to explain the proposed product, identify the customers and counterparties involved, limit the scale and duration of the experiment, protect customer funds and information, demonstrate AML/CFT controls, and maintain reliable records for supervisory review.

UmojaFlowOS supports that operating discipline by treating the test plan as a governed object rather than a document that sits outside the system. Approved use, user category, transaction limit, aggregate exposure, duration, wind-down plan, success metrics, and evidence obligations become machine-checkable control inputs.

The platform is deliberately not presented as replacing the CBN or granting permission. CBN remains the supervisory authority. UmojaFlowOS provides the operating controls, audit trail, and evidence structure needed for the applicant and supervisor to understand what happened during a controlled experiment.

The distinction between a sandbox and live production is critical. A sandbox allows controlled learning. It does not authorise unrestricted customer activity, unbounded settlement, or use of synthetic evidence as if it were real regulatory proof.

**Transition:** With that mission in mind, the next slide shows how the platform connects the major control layers.

---

## Slide 3 — Architecture: From Identity to Immutable Evidence

**Suggested time:** 3 minutes

This diagram shows the platform as a chain of accountability.

At the beginning is identity and authority. Keycloak provides the identity boundary, while role and subject controls determine who may submit, review, approve, release, reconcile, or investigate an action.

The next layer is policy and workflow. Before value movement is considered, the platform evaluates product boundaries, customer consent, transaction limits, counterparty status, jurisdiction, and required approvals.

The compliance layer performs AML, CFT, CPF, sanctions, KYC, KYB, Travel Rule, and risk assessments. A failed or unavailable control does not silently become a pass. The fail-closed design is intended to stop the workflow or hold it for review.

The financial layer separates operational control state from ledger truth. PostgreSQL stores workflow and evidence state. TigerBeetle is the intended double-entry ledger boundary for authoritative financial postings. Reconciliation checks compare the financial facts rather than assuming that a successful API response equals settlement.

The final layer is evidence and operations. Immutable or write-once retention protects material records, while monitoring and incident workflows make failures visible. The result is a traceable path from a named actor and approved authority to a decision, a financial fact, and independently reviewable evidence.

**Transition:** The next slide maps this architecture to the specific control outcomes expected in a responsible sandbox.

---

## Slide 4 — CBN Requirement to UmojaFlowOS Control Mapping

**Suggested time:** 3 minutes

This mapping is designed to answer the question: how would a reviewer know that the requirement is not merely described, but actually operating?

For AML, CFT, sanctions, and customer risk, the platform records the screening request, provider response, source version, decision, analyst action, and evidence references. The integration contract requires authentication, replay protection, time-bound requests, and clear handling of unavailable providers.

For consumer protection, the platform captures consent, applies transaction and exposure limits, and records rejected or held attempts. That gives the supervisor a way to examine not only successful transactions but also the controls that prevented an unsafe transaction.

For operational resilience, the system uses fail-closed workflow states, explicit timeout and indeterminate outcomes, incident records, recovery evidence, and reconciliation gates. A system that cannot prove the result is not treated as safely complete.

For financial integrity, intended postings, ledger facts, settlement references, and PostgreSQL projections are reconciled. A discrepancy creates an exception rather than being hidden by a status update.

For governance and auditability, segregation of duties, independent review, cryptographic hashes, release binding, and immutable retention reduce the risk that the same individual can create, approve, and certify their own evidence.

The important point is that each control still requires real evidence. Code can implement the mechanism, but it cannot prove that the organisation has appointed the right people, signed the right agreements, or completed a real supervised test.

**Transition:** Those real-world dependencies are visible at the trust boundaries shown next.

---

## Slide 5 — External Integrations and Trust Boundaries

**Suggested time:** 3 minutes

No compliance platform is an island. Its reliability depends on how it handles external identity, compliance, liquidity, ledger, storage, and monitoring systems.

Keycloak establishes the identity and access boundary through OIDC claims, token validation, role mapping, expiry, and revocation controls.

Third-party AML and sanctions providers connect through a documented contract. Requests need correlation IDs, idempotency keys, freshness checks, and authenticated responses. Provider downtime, malformed responses, and ambiguous results must produce a hold or an indeterminate outcome, not an automatic release.

Liquidity and market-data providers are treated as evidence-bearing sources. Rates, quotes, capacity confirmations, and provider authorisation records must be tied to a timestamp, source reference, and integrity digest.

The ledger boundary is intentionally explicit. PostgreSQL is not treated as a substitute for the authoritative financial ledger. TigerBeetle integration and reconciliation are separate controls, with failures producing an exception path.

WORM evidence storage protects the record after a decision. Monitoring systems provide operational visibility, but monitoring itself is not a replacement for the durable evidence record.

For technology partners, these trust boundaries define where an integration must provide credentials, certificates, schemas, error semantics, audit events, and tested recovery behavior.

**Transition:** The next slide explains how all of those interactions become a reviewable evidence chain.

---

## Slide 6 — Evidence and Independent Assurance

**Suggested time:** 3 minutes

A regulator or board should not have to accept a statement that a control worked. The platform is designed to show the evidence, its digest, its origin, its release binding, and its reviewer.

The E-01 through E-09 evidence model starts with build and release provenance and continues through security, identity, database, ledger, provider, resilience, and final independent verification evidence.

Each artifact is linked to an evidence identifier, a run, a release SHA, a path or immutable URI, and a SHA-256 digest. If the artifact changes, its digest no longer matches the release manifest.

The evidence state machine distinguishes open, evidence recorded, externally verified, and rejected states. This prevents an empty record from being mistaken for completed evidence and prevents a reviewer from certifying evidence that was never submitted.

The independent E-09 review is a separate control. The person who ran the test should not be the person who independently verifies the final release evidence. The production release also requires distinct Release, Security, Compliance, and Operations approvals, bound to the same release SHA.

This structure helps CBN, internal audit, and business partners answer four questions: what was tested, which version was tested, who performed and reviewed it, and whether the evidence has been altered.

**Transition:** Those assurance controls create different value for each stakeholder group.

---

## Slide 7 — Value to CBN, Government, Partners, and Citizens

**Suggested time:** 3 minutes

For CBN, the value is supervisory visibility and policy learning. The platform creates a common vocabulary for test boundaries, exceptions, evidence, incidents, and outcomes. It can help distinguish a genuinely safe experiment from an uncontrolled production rollout.

For ministries and public-sector decision-makers, the value is a reusable, cloud-agnostic control layer. It supports national data-sovereignty choices, consistent reporting, and the ability to compare outcomes across approved experiments without requiring every participant to build a different evidence system.

For financial institutions and liquidity partners, the value is a standard integration and reconciliation contract. They can see what information is required, what approvals are needed, how errors are handled, and how a transaction is prevented from being represented as settled before the financial facts are reconciled.

For compliance, security, and operations teams, the value is reduced manual coordination. The workflow makes holds, exceptions, evidence requests, approvals, incident response, and recovery visible in one place.

For citizens and businesses, the value is protection before value moves: consent, limits, screening, recourse, clear status, and an auditable record when something goes wrong.

The platform’s economic value should be measured through controlled indicators such as prevented loss, reduced reconciliation time, reduced evidence-assembly effort, faster incident containment, compliant formalisation, and safer innovation—not through unsupported promises of revenue or savings.

**Transition:** The final substantive slide makes the boundary between implemented capability and regulatory readiness explicit.

---

## Slide 8 — Readiness Boundary and Path to GO

**Suggested time:** 3 minutes

The platform has a substantial local technical foundation: governance schemas, semantic validation, fail-closed workflows, evidence-manifest verification, local Compose deployment assets, a synthetic Nigerian scenario seeder, and documented provider contracts.

That technical foundation is not the same as production authorisation.

The current local seed is synthetic. It is useful for testing database relationships, lifecycle rules, dashboards, and user journeys. It must not be used as CBN evidence, UBO evidence, customer data, AML evidence, or proof of live provider operation.

The path to GO requires several external actions. First, the applying entity and Nigerian regulatory nexus must be verified. Second, ownership, UBO, financial, governance, and signatory records must be authenticated. Third, real Keycloak, AML, liquidity, ledger, storage, and monitoring integrations must be provisioned in an approved staging environment. Fourth, E-01 through E-08 must be executed with real staging evidence. Fifth, an independent reviewer must complete E-09. Finally, the four independent production roles must approve the exact release SHA and Legal and Compliance must authorise submission.

A responsible GO decision therefore means more than passing automated tests. It means the technical controls, operating procedures, external dependencies, legal evidence, and independent approvals all agree.

**Transition:** The closing slide summarises the partnership decision and the responsible path forward.

---

## Slide 9 — A Responsible Path from Innovation to Trust

**Suggested time:** 2 minutes

UmojaFlowOS is intended to bridge innovation and accountability.

The immediate partnership ask is to validate the operating model in a controlled environment: agree the product boundary, appoint accountable officers, provision the approved staging services, connect real providers under governed contracts, execute the evidence plan, and invite independent review.

For CBN and government stakeholders, the proposed outcome is better visibility and safer policy learning. For business partners, it is a common control and integration contract. For citizens, it is a stronger expectation that consent, screening, limits, recourse, and evidence exist before value moves.

The platform should be judged on measurable outcomes: fewer uncontrolled exceptions, faster detection and containment, faster reconciliation, complete evidence packages, transparent test boundaries, and no unauthorised transition from sandbox activity to live value movement.

The request is not for trust based on a demonstration. It is for a structured path in which the controls are tested, the evidence is independently reviewed, and the final decision remains with the appropriate authorities.

Thank you. I welcome questions on the operating model, control boundaries, evidence requirements, integration responsibilities, and the remaining steps to reach a properly supported GO decision.

---

# Anticipated Questions and Suggested Answers

## Is UmojaFlowOS a bank, payment service provider, or VASP licence?

No. UmojaFlowOS is a software control and evidence platform. It does not grant a licence, replace a regulated institution, or remove the need for CBN approval and other applicable authorisations.

## Does the local synthetic seed prove regulatory readiness?

No. It proves that the local database and application contracts can be exercised with synthetic data. Real regulatory readiness requires authenticated organisational records, real staging integrations, real evidence, independent review, and authorised approvals.

## What happens when an AML or liquidity provider is unavailable?

The required behavior is fail-closed: the action is held, rejected, or marked indeterminate according to the approved policy. It must not silently proceed as if the check passed.

## Who can approve a release?

The release process requires four distinct subjects in Release, Security, Compliance, and Operations roles, with release-SHA binding and segregation of duties. A person must not approve their own evidence or perform incompatible control functions.

## How does the platform protect customer data?

The design uses identity and role boundaries, minimum necessary data exchange, encrypted transport, controlled evidence references, access review, retention rules, and separation between synthetic local fixtures and real customer records. The final data-protection posture still requires legal and security review in the deployment jurisdiction.

## What is the economic value to Nigeria?

The appropriate approach is to measure verified outcomes rather than promise a fixed dollar value. A supervised pilot can establish a baseline for prevented losses, reconciliation time, compliance effort, incident containment, formal-sector participation, and partner onboarding. Any dollar estimates should be presented as scenario ranges with assumptions, sensitivity analysis, and independent validation.

## What is the single most important next step?

Complete the authorised evidence package: verify the applying entity and UBO structure, approve the sandbox test boundary, provision real staging integrations, execute E-01 through E-08, complete independent E-09 review, and obtain the four distinct release approvals before submission or live activation.
