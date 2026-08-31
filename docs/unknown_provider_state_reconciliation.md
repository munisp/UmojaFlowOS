# UNKNOWN Provider-State Reconciliation Protocol

## Purpose

An `UNKNOWN` provider outcome means the platform cannot prove that the primary rail had no business effect. The transaction is therefore placed in a durable reconciliation queue and the payment workflow stops. The reconciliation worker is an evidence processor only: it may query a provider’s read-only status endpoint and compare the result with the ledger and PostgreSQL projection, but it must never submit a transfer, choose a secondary rail, authorize settlement, or mutate a financial balance.

## State machine

| Observed evidence | Durable decision | Secondary submission | Settlement authority |
|---|---|---:|---:|
| Provider confirms `submitted`, `pending`, or `settled` | `provider_accepted_no_settlement_authority` | No | False |
| Provider confirms `failed` or `held` and explicitly marks `safe_to_retry=true` | `confirmed_non_submission` | No automatic action; separate authorized command only | False |
| Provider query times out, is unavailable, or returns `unknown` | `awaiting_provider_evidence` with bounded retry | No | False |
| Provider facts disagree with webhook, intent, or ledger evidence | `quarantined_reconciliation_failure` | No | False |
| Maximum attempts or evidence retention deadline is reached | `quarantined_reconciliation_failure` | No | False |

A `confirmed_non_submission` decision is not permission to execute the secondary rail. It only establishes an evidence fact. Any subsequent retry must be a new, explicitly authorized command with the original idempotency key and a fresh policy decision. This prevents the reconciliation worker from becoming an indirect payment executor.

## Durable storage contract

The queue is backed by PostgreSQL. A worker claims one record with `FOR UPDATE SKIP LOCKED`, increments the attempt counter in the same transaction, and records exactly one immutable decision for each terminal reconciliation result. A claim lease prevents two workers from querying and deciding on the same row concurrently.

```sql
CREATE TABLE IF NOT EXISTS provider_unknown_reconciliation (
    id UUID PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    intent_id UUID NOT NULL,
    primary_rail TEXT NOT NULL,
    provider_reference TEXT,
    observed_status TEXT NOT NULL CHECK (observed_status IN ('unknown','submitted','pending','settled','failed','held')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL,
    lease_until TIMESTAMPTZ,
    last_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS provider_unknown_reconciliation_due_idx
    ON provider_unknown_reconciliation (next_attempt_at)
    WHERE resolved_at IS NULL;

CREATE TABLE IF NOT EXISTS provider_reconciliation_decision (
    id UUID PRIMARY KEY,
    idempotency_key TEXT NOT NULL,
    intent_id UUID NOT NULL,
    primary_rail TEXT NOT NULL,
    provider_reference TEXT,
    decision TEXT NOT NULL CHECK (decision IN (
        'provider_accepted_no_settlement_authority',
        'confirmed_non_submission',
        'awaiting_provider_evidence',
        'quarantined_reconciliation_failure'
    )),
    observed_status TEXT NOT NULL,
    settlement_allowed BOOLEAN NOT NULL CHECK (settlement_allowed = false),
    attempt INTEGER NOT NULL CHECK (attempt > 0),
    reason TEXT NOT NULL,
    decided_at TIMESTAMPTZ NOT NULL,
    evidence_digest TEXT NOT NULL,
    UNIQUE (idempotency_key, attempt)
);
```

The application must calculate `evidence_digest` from the canonical serialized intent, provider response, ledger evidence, decision, and attempt number. The digest is stored with the immutable decision and included in the WORM evidence envelope. A later record cannot overwrite a previous decision.

## Worker transaction protocol

The worker executes the following sequence for each due record:

1. Begin a PostgreSQL transaction and claim one due queue row with `FOR UPDATE SKIP LOCKED`. Set `lease_until` to a short bounded lease and increment `attempts` atomically.
2. Commit the claim before making the provider query. The provider call is read-only, uses an explicit timeout, and is never retried through a write endpoint.
3. Validate the response against the original idempotency key, intent identifier, provider reference, currency, amount, and correlation identifier. Missing or mismatched facts are quarantined.
4. If the response is inconclusive, schedule the next attempt using bounded exponential backoff with a maximum delay and maximum attempts. Do not create a new payment order.
5. If the response is conclusive, append an immutable decision with `settlement_allowed=false`. Mark the queue row resolved only after the decision append succeeds.
6. Publish a redacted operational event containing the decision, attempt, correlation identifier, and evidence digest. Do not include provider secrets, access tokens, or full personal data in logs.

A worker crash before decision append leaves the queue row claimable after lease expiry. A crash after decision append but before queue resolution is handled by the unique `(idempotency_key, attempt)` constraint and an idempotent recovery transaction.

## Operational controls

The queue is fail-closed when PostgreSQL, the provider read-only endpoint, the immutable decision store, or the evidence store is unavailable. The worker raises an alert for lease expiry bursts, repeated provider inconclusive results, digest mismatches, and any attempted write call from the reconciliation process. Access to the queue and decision tables is separated from payment execution credentials; reconciliation operators can inspect and quarantine records but cannot submit transfers.

## Required acceptance tests

The implementation must prove that a provider `unknown` response never calls the secondary rail, a provider query timeout is rescheduled, a query-confirmed safe failure produces evidence but no submission, a settled provider result never sets settlement authority, two workers cannot claim the same row concurrently, a changed intent under an existing idempotency key is rejected, an evidence mismatch is quarantined, and a crash between append and resolution is recovered idempotently.
