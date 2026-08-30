# UmojaFlowOS Third-Party Provider API Integration Specification

**Version:** 1.0  
**Audience:** AML/sanctions providers, Travel Rule providers, liquidity providers, banks, payment service providers, custodians, system integrators, and security reviewers.

## 1. Integration principles

UmojaFlowOS treats each third-party provider as an untrusted external dependency. A provider cannot activate itself, approve a customer, release a payment, change a ledger fact, or bypass a policy. The platform validates identity, endpoint, certificate, credential health, contract version, permissions, freshness, idempotency, and evidence before consuming a response.

The provider must support a test environment with synthetic records and an explicit failure contract. Production credentials and customer data are prohibited in local staging. Live execution remains disabled until the responsible institution, provider, compliance owner, security owner, and operations owner approve the integration.

## 2. Connectivity and authentication

| Control | Requirement |
|---|---|
| Transport | TLS 1.2 or later; mTLS is required for sensitive internal/provider paths where supported |
| Request authentication | Provider-specific HMAC or OAuth 2.0 client credentials; secrets supplied through a managed secret reference |
| Token validation | Issuer, audience, signature, expiry, scope, and client identity are validated |
| Replay protection | Unique request ID plus timestamp freshness window; duplicates are idempotently rejected |
| Source restriction | Approved CIDR or private-network boundary where the provider supports stable source ranges |
| Payload limits | Maximum body size, content type, schema version, and field lengths are enforced |
| Timeouts | Connect, read, and total deadlines are configured per provider contract |
| Logging | Correlation ID, provider request ID, outcome, latency, and digest; never log credentials or raw identity documents |

## 3. Common request envelope

```json
{
  "request_id": "01JEXAMPLE0000000000000000",
  "correlation_id": "01JEXAMPLE0000000000000001",
  "contract_version": "1.0",
  "sent_at": "2026-08-30T12:00:00Z",
  "idempotency_key": "synthetic-case-001-screen-001",
  "participant_id": "synthetic-participant-001",
  "payload_digest_sha256": "<64 lowercase hex characters>",
  "payload": {}
}
```

The provider must echo `request_id`, `correlation_id`, `contract_version`, and `idempotency_key` in its response.

## 4. Common response envelope

```json
{
  "request_id": "01JEXAMPLE0000000000000000",
  "correlation_id": "01JEXAMPLE0000000000000001",
  "provider_request_id": "provider-request-001",
  "contract_version": "1.0",
  "received_at": "2026-08-30T12:00:01Z",
  "status": "accepted",
  "decision": "review_required",
  "source_version": "provider-dataset-or-policy-version",
  "result_digest_sha256": "<64 lowercase hex characters>",
  "errors": []
}
```

A response with an invalid digest, missing provider reference, stale source version, contradictory decision, or unrecognised contract version is rejected or placed in review.

## 5. Compliance provider contract

### 5.1 Screening request

```http
POST /v1/screening/cases
Content-Type: application/json
Authorization: Bearer <short-lived-token>
Idempotency-Key: synthetic-case-001-screen-001
X-Umoja-Correlation-Id: 01JEXAMPLE0000000000000001
```

```json
{
  "request_id": "01JEXAMPLE0000000000000000",
  "correlation_id": "01JEXAMPLE0000000000000001",
  "contract_version": "1.0",
  "sent_at": "2026-08-30T12:00:00Z",
  "idempotency_key": "synthetic-case-001-screen-001",
  "participant_id": "synthetic-participant-001",
  "payload_digest_sha256": "<digest>",
  "payload": {
    "subject_type": "individual",
    "subject_reference": "synthetic-subject-001",
    "name": "Synthetic Subject 001",
    "country": "NG",
    "date_of_birth": "1990-01-01",
    "purpose": "sandbox_test_screening"
  }
}
```

The production contract must minimise data. Raw identity documents and unnecessary personal data must not be sent. For production, the provider and data-protection officer must approve the lawful basis, retention, cross-border transfer, and deletion model.

### 5.2 Required compliance outcomes

The provider must return one of `clear`, `potential_match`, `false_positive_candidate`, `review_required`, `unavailable`, or `rejected`. A potential match, unavailable service, malformed response, or stale dataset cannot be converted to `clear` by an automated caller.

```json
{
  "status": "completed",
  "decision": "potential_match",
  "match_reference": "provider-match-001",
  "source_version": "sanctions-2026-08-30",
  "matched_lists": ["synthetic-list-for-testing"],
  "analyst_review_required": true,
  "expires_at": "2026-09-06T12:00:00Z"
}
```

The platform records the provider source/version, decision, analyst disposition, escalation, timestamp, evidence digest, and any SAR/STR decision separately from the provider’s raw response.

### 5.3 Travel Rule contract

The provider must document supported originator/beneficiary fields, secure delivery, refusal/hold behavior, retry rules, privacy controls, counterparty identity, and response time. If no approved counterparty is available, the first sandbox test must explicitly exclude Travel Rule activity and preserve the signed rationale.

## 6. Liquidity-provider contract

Liquidity providers expose indicative quotes and execution acknowledgements. A quote is not a settlement fact.

### 6.1 Quote request

```http
POST /v1/liquidity/quotes
Content-Type: application/json
Idempotency-Key: synthetic-quote-001
```

```json
{
  "request_id": "01JEXAMPLE0000000010",
  "correlation_id": "01JEXAMPLE0000000011",
  "contract_version": "1.0",
  "sent_at": "2026-08-30T12:00:00Z",
  "idempotency_key": "synthetic-quote-001",
  "payload": {
    "source_currency": "NGN",
    "destination_currency": "USD",
    "source_amount_minor": "25000000",
    "instrument": "approved_test_instrument",
    "expires_in_seconds": 30,
    "purpose": "sandbox_liquidity_test"
  }
}
```

The provider must return quote ID, rate, fees, spread, expiry, liquidity source, limits, and a provider signature or authenticated response reference. The platform refuses expired, over-limit, unsigned, or contradictory quotes.

### 6.2 Execution acknowledgement

Execution acknowledgements must contain a provider event ID, order ID, accepted amount, currency, status, settlement expectation, and immutable provider reference. The platform requires a separate confirmed settlement event before treating the workflow as settled.

```json
{
  "provider_event_id": "provider-event-001",
  "order_id": "synthetic-order-001",
  "status": "accepted",
  "source_amount_minor": "25000000",
  "source_currency": "NGN",
  "destination_amount_minor": "16000",
  "destination_currency": "USD",
  "settlement_reference": "provider-settlement-ref-001",
  "received_at": "2026-08-30T12:00:05Z"
}
```

## 7. Failure and retry semantics

| Failure | UmojaFlowOS action |
|---|---|
| Timeout | Mark indeterminate; do not retry a non-idempotent action without provider reconciliation |
| HTTP 429 | Back off within configured deadline; preserve rate-limit evidence |
| HTTP 5xx | Circuit breaker may open; no silent approval or settlement |
| Invalid signature | Reject, alert security, preserve digest and correlation ID |
| Stale screening source | Place in review; do not pass automatically |
| Duplicate event | Return idempotent result; never double-post |
| Provider unavailable | Fail closed for dependent action |
| Contradictory amount/status | Create reconciliation exception and pause workflow |
| Certificate failure | Disable integration and require security-owner review |
| Scope/role failure | Reject and record authorisation exception |

## 8. Evidence and audit requirements

Every request, response, retry, timeout, circuit transition, analyst decision, and reconciliation result must be attributable to a release SHA, correlation ID, provider, contract version, subject, timestamp, and digest. Evidence is stored through the approved gateway and retained according to legal hold and WORM policy. The provider must support evidence export or an independently verifiable reference.

## 9. Activation checklist

Before activation, the provider and UmojaFlowOS owners must complete endpoint and certificate verification, data-protection review, contract and SLA approval, test credentials, clear/hit/false-positive/timeout/unavailable cases, idempotency and replay tests, rate-limit tests, alert routing, reconciliation, rollback, evidence publication, and independent security review. The final activation record must identify the responsible business owner, compliance owner, security owner, operations owner, and expiry/review date.

## 10. Non-production test suite

At minimum, test a clear screening response, a match requiring review, a false-positive disposition, an unavailable provider, a timeout, a stale result, a duplicate request, a duplicate event, a signature mismatch, a quote expiry, a liquidity limit breach, a settlement mismatch, and a provider credential rotation. All tests use synthetic records and cannot be used as CBN live evidence.
