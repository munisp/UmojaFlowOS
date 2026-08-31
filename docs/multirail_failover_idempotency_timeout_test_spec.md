# Multi-Rail Failover and Idempotency Test Specification

## Safety invariant

A timeout is not evidence of non-submission. If a provider may have accepted an intent, UmojaFlowOS must query the provider or reconcile an authoritative fact before selecting another rail. An `UNKNOWN` outcome blocks fallback. The same global intent ID and idempotency key must be preserved across retries and rail selection.

## Test matrix

| ID | Scenario | Expected outcome |
|---|---|---|
| MR-001 | Primary returns accepted/submitted | Primary selected; one submission; result recorded. |
| MR-002 | Primary returns settled | Primary selected; no secondary call. |
| MR-003 | Primary returns confirmed failed before submission | Secondary may be selected once. |
| MR-004 | Primary transport error and query confirms failed | Secondary may be selected once. |
| MR-005 | Primary transport error and query is unknown | Secondary not called; intent held for reconciliation. |
| MR-006 | Primary explicitly returns unknown | Secondary not called; alert and reconciliation case opened. |
| MR-007 | Primary timeout and later query returns pending | Primary remains selected; no secondary call. |
| MR-008 | Primary timeout and later query returns settled | Primary remains selected; no secondary call. |
| MR-009 | Secondary returns timeout/unknown | No success acknowledgement; intent remains held or unknown. |
| MR-010 | Duplicate request with same global idempotency key | Cached original result; no new provider submission. |
| MR-011 | Same idempotency key with changed amount or asset | Reject as idempotency conflict. |
| MR-012 | Concurrent duplicate requests | Exactly one provider submission and one durable decision. |
| MR-013 | Provider callback repeats | One business effect; duplicate callback audited and ignored. |
| MR-014 | Provider callback has wrong correlation or amount | Reject callback; open reconciliation exception. |
| MR-015 | Secondary rail unavailable | No false success; preserve primary failure and alert Operations. |
| MR-016 | Intent expires during retry | Reject/hold; no secondary submission after expiry. |
| MR-017 | Failover policy disallows secondary for corridor/asset | Hold/reject; no secondary submission. |
| MR-018 | Reconciliation later proves primary settled after secondary submission | Escalate double-effect risk; freeze further movement and reconcile. |

## Required evidence

Each test records the release SHA, policy digest, environment, intent ID, global idempotency key, provider-specific idempotency keys, timestamps, request/response digests, provider references, query results, decision, rail selected, audit event IDs, and final reconciliation state. Secrets and private customer data are excluded or redacted.

## Release gate

The suite passes only when every mandatory scenario has an observed expected result, no test is skipped without an approved environment reason, no duplicate business effect occurs, unknown outcomes never trigger fallback, and the test report is bound to the exact release SHA and policy digest.
