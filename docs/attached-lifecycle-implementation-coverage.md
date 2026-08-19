# Attached cross-border lifecycle: implementation coverage

This document maps the supplied cross-border payment lifecycle diagram and stakeholder operating model to the UmojaFlowOS implementation. The lifecycle is implemented as an **evidence-led, fail-closed orchestration model** for Nigeria (**NGN**), Kenya (**KES**), and South Africa (**ZAR**). A feature is described as active only where its real local or authorised external runtime has been verified; all counterparty-dependent movement remains explicitly activation-gated.

## Lifecycle map

| Attached lifecycle stage | Implemented control plane and service boundary | Current authority boundary |
| --- | --- | --- |
| 1. Payment initiation | Canonical PostgreSQL payment orders, customer/beneficiary bindings, Go lifecycle validation, typed TypeScript forms, immutable audit trail. | A draft is not an execution instruction. |
| 2. Customer authentication and role checks | OAuth session, optional verified Keycloak JWT federation, router procedures, role-aware console, and Permify resource checks. | Authentication and a role do not approve money movement. |
| 3. KYB/KYC, beneficiary/wallet screening | Consent-backed document ledger, digest verification, PaddleOCR/Docling/Ollama evidence pipeline, compliance cases, Rust monitoring/risk, and human review. | Evidence is review-required; no model or screening signal grants automated approval. Live sanctions, blockchain, and wallet-screening providers remain gated. |
| 4. Quote/RFQ and route selection | Recorded market observations, source-derived spreads, canonical rate locks, and Yellow Card HMAC RFQ boundary for USDC/USDT-to-NGN/KES/ZAR offers. | An RFQ is an offer reference; it cannot accept a conversion or payment. Yellow Card connectivity needs a licensed, configured partner. |
| 5. Funding confirmation | Reconciled liquidity positions, buffer policy, treasury recommendations, and deterministic liquidity stress/alert evaluation. | It neither reserves provider funds nor confirms external settlement without verified evidence. |
| 6. Execution and stablecoin/liquidity conversion | Go payment engine, Temporal durable workflow, TigerBeetle adapter, Rust posting/projection verification, USDC/USDT exposure calculation, and provider-safe contract boundary. | TigerBeetle and stablecoin counterparties are not live until configured and independently verified. |
| 7. Local payout/supplier settlement | Provider-independent payment-leg lifecycle and a real Mojaloop FSPIOP asynchronous request adapter. | A Mojaloop HTTP 202 is only an accepted asynchronous reference; local rails and licensed counterparties remain gated. |
| 8. Reconciliation, reporting, and audit trail | Rust reconciliation gateway, PostgreSQL projection, immutable activity events, CBN/CBK/SARB report assembly, stablecoin exposure, compliance alerts, and operational dashboards. | A matched projection is reconciliation evidence, not regulator submission or settlement finality. |
| Exceptions/manual review | Compliance cases, terminal alerts, retry boundaries, independent recommendations/approvals, and stakeholder guidance. | A refusal remains a refusal; retry is offered only for transport failure, never to override a policy decision. |

## Governing event and workflow fabric

The attached event timeline is implemented as a controlled evidence flow rather than a set of unverified status strings.

```text
Go payment event / Rust policy evidence
        ↓
Kafka-compatible Redpanda or Dapr / Fluvio (configured only)
        ↓
Python validates CloudEvent type, topic, version, and non-execution authority
        ↓
Redis atomically records de-duplication evidence and appends the validated event
        ↓
Optional governed lifecycle projection to immutable lakehouse bronze object
        ↓
Approved reporting, aggregate geospatial analysis, or stakeholder evidence view
```

Temporal owns replay-safe payment workflow steps; Permify owns per-resource authorisation checks; PostgreSQL owns the operational lifecycle and compliance record. Kafka/Dapr/Fluvio and Redis cannot advance a payment state just by receiving an event.

## Lakehouse, advanced analytics, AI/ML/DL

The lakehouse is integrated as an **immutable, redacted analytics projection**, not a second operational database.

| Layer | Implemented behaviour | Prohibitions |
| --- | --- | --- |
| Bronze evidence | Python writes governed NDJSON through S3-compatible conditional immutable puts, with deterministic digest metadata. The lifecycle projector accepts only validated event metadata after durable de-duplication acknowledgement. | Rejects customer, account, wallet, document, credential, and raw-location fields. |
| Silver/aggregate preparation | Apache Sedona job submission through Livy accepts only approved aggregate columns and cohort-suppressed data. | No raw participant-level map, location trail, or transaction reconstruction. |
| Gold/visual publication | GeoLibre 0.1.0 project generation points to a signed HTTPS aggregate URL; it does not embed credentials or raw data. | No user-uploaded map project, data URL, or direct source-credential exposure. |
| AI/ML/DL evidence | OCR/document intelligence and the Ollama selector generate evidence only; Rust rules provide deterministic monitoring/risk; report assembly uses exact Decimal arithmetic. | No automatic KYC/KYB approval, payment approval, filing submission, or treasury action. |

The lifecycle-event lakehouse projection is configured only when a validated lakehouse writer is available. If unavailable, the Python consumer preserves its durable event acknowledgement behaviour without inventing analytics storage success.

To make the lakehouse coverage explicit across the platform, `lakehouse_catalog.py` defines one governed catalog for **PostgreSQL control**, **TigerBeetle reconciliation**, **Temporal workflow**, **Permify authorisation**, **Rust risk**, **AI/ML evidence**, **stablecoin exposure**, **provider lifecycle**, and **service-health** evidence. Every catalog row must use a pre-hashed correlation reference, an approved source, a timezone-qualified observation time, an approved outcome, and optional supported corridor/USDC/USDT/model-role fields. The contract rejects unknown fields, direct identifiers, credential fields, raw location, execution verbs, and a caller-supplied authority claim. Its output forcibly sets `authoritative: false` before the immutable bronze writer receives it.

## Stablecoin and Yellow Card posture

The platform deliberately supports **USDC and USDT only**. It calculates exposure with exact Decimal arithmetic; reports peg deviation as an observation; applies corridor-aware NGN/KES/ZAR controls; and rejects an unsupported asset before any provider request.

The Go `YellowCardClient` implements the public HMAC request construction for `POST /rfq`, validates UUID idempotency, constrains source asset to USDC/USDT, verifies the returned RFQ matches the submitted offer, and verifies a signed Yellow Card webhook before accepting its minimal lifecycle metadata. It does **not** accept an RFQ, create a wallet, move a stablecoin, or mark a payment settled. The adapter is inactive until licensed counterparty onboarding, secret-reference configuration, production IP allowlisting, and sandbox verification are approved. See `docs/yellow-card-provider-audit.md` for the public-contract sources and exact activation conditions.

## Stakeholder operating model

The overview now provides a role-specific onboarding workspace backed by recorded signals, plus a canonical counterparty onboarding lifecycle:

| Stakeholder | Defined journey | Independent controls |
| --- | --- | --- |
| Administrator | Register counterparty, record country overlays, provide legal evidence, then oversee technical readiness. | Can create lifecycle and decide technical readiness, but cannot make compliance legal or pilot approvals. |
| Compliance officer | Record legal evidence, decide legal review, participate in the pilot decision, and start due recertification. | Legal and pilot decisions are immutable evidence, not provider activation. |
| Treasury operator | Review reconciled liquidity and decide the treasury half of a pilot. | Cannot create lifecycle, approve legal review, or activate a provider. |
| Auditor | Inspect lifecycle, decision, operational, report, and service evidence. | Read-only; cannot decide a gate or alter an operational record. |

The canonical lifecycle proceeds only through `legal_onboarding → technical_readiness → pilot → steady_state`, with a blocked terminal state and a due recertification cycle returning to legal review. Legal approval requires a verified counterparty authorisation; technical approval requires a verified active integration; pilot requires two independent actors of the required roles. None of those stages creates an external provider activation path.

## Completion statement

The attached architecture is **implemented as the platform’s controlled operating model**. All provider-independent portions are represented in code, schema, tests, UI, and documented authority boundaries. The remaining gaps are not missing architecture: they are activation gates requiring actual credentials, licensed counterparties, authoritative external rails, and provisioned production runtimes. UmojaFlowOS refuses to simulate those conditions or label them complete without evidence.
