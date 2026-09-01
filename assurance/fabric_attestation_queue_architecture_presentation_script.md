# Fabric Attestation Queue Architecture — Presentation Script

## Slide 1 — Why the queue exists

UmojaFlowOS uses Hyperledger Fabric as a consortium attestation layer, not as the authority for customer funds. TigerBeetle remains the authoritative double-entry ledger, while PostgreSQL provides durable settlement identity, queue state, and reconciliation evidence. The queue exists because a Fabric submission can be slow, partitioned, endorsed but not yet committed, or committed while the client is unable to observe the commit.

The governing rule is simple: ambiguity holds the operation. The platform must never convert a timeout into a presumed failure and must never issue a blind duplicate submission.

## Slide 2 — Durable PostgreSQL work identity

Each attestation job has a unique idempotency key. The queue also stores the release SHA, evidence ID, evidence URI, payload digest, and approved endorsement scope. The payload digest is format-checked, and the release SHA is constrained to the expected lowercase hexadecimal form.

An enqueue operation uses `ON CONFLICT DO NOTHING`. A repeated request therefore returns the existing work identity instead of creating a second queue item. PostgreSQL is the cross-replica authority for this deduplication; an in-memory map would not be sufficient across payment-engine instances.

## Slide 3 — Claiming work safely across replicas

Workers claim jobs in short PostgreSQL transactions using `FOR UPDATE SKIP LOCKED`. This allows multiple replicas to poll the same queue without waiting behind already claimed rows. The database lock is held only while the row is selected and marked as running. It is not held while the worker communicates with Fabric.

Every claim increments the attempt count, creates a UUID lease token, and records a lease expiry. A worker that loses its lease cannot mark the job complete or overwrite a newer worker’s result. Expired running leases become eligible for recovery.

## Slide 4 — Local admission control

The database protects durable identity, while the process-local admission controller protects runtime capacity. A bounded semaphore limits the number of Fabric Gateway calls that can wait concurrently for endorsement and commit status.

When all slots are occupied, a caller waits only until its context deadline. If the context is canceled, the caller receives the cancellation error and the operation remains held or pending. This prevents a 30-second commit timeout from multiplying into an unbounded number of goroutines, connections, and upstream requests.

## Slide 5 — Submission and commit timeout

The Go Gateway client uses Fabric Gateway’s `SubmitWithContext` API. The caller context bounds the submission path, and the Gateway is configured with a validated commit-status timeout. The default is 30 seconds, with a five-minute maximum.

The timeout is not a 30-second delay on healthy transactions. A healthy committed transaction returns as soon as commit status is observed. The cost appears when the orderer, peer event service, Gateway, or network is slow. At that point, each in-flight operation consumes bounded worker capacity until it returns or becomes UNKNOWN.

## Slide 6 — MVCC conflict handling

The chaincode derives an attestation ID from the release SHA, evidence ID, and evidence digest. Identical requests target the same ledger key. The chaincode checks whether the key exists and then writes the attestation state.

Two concurrent endorsing transactions may both observe an absent key, but Fabric’s validation phase must allow only one conflicting write to commit. The losing transaction should surface an MVCC read conflict. The application records this as a duplicate/conflict outcome rather than retrying blindly.

The local simulation used 100 concurrent identical submissions and observed one success with 99 MVCC-style conflicts. That result validates the safety model, but only a real multi-peer Fabric network can establish production endorsement throughput and conflict latency.

## Slide 7 — UNKNOWN reconciliation

When the caller deadline or commit-status wait expires, the queue transitions the job from running to UNKNOWN and schedules a future reconciliation attempt. The lease token must match, otherwise the update fails closed.

The reconciliation worker performs only a read-only Fabric query. It never calls Submit, never selects a secondary rail, and always emits `settlement_allowed=false`. If Fabric confirms an accepted attestation, the system records provider acceptance without granting settlement authority. If Fabric confirms no business effect, the system records that result but requires a separate authorized execution command before any new submission.

## Slide 8 — Recovery and duplicate safety

After a partition is repaired, the worker queries the original attestation identity and digest. If the transaction committed during the outage, the queue closes through read-only evidence and does not resubmit. If the transaction did not commit and a trusted provider result explicitly confirms no business effect, a later separately authorized command may create a new execution attempt under a new controlled identity.

Lease loss, digest mismatch, conflicting terminal decision, or missing evidence keeps the operation held. There is no automatic path from uncertainty to funds movement.

## Slide 9 — Observability and audit evidence

The platform should export tenant-safe metrics for queue depth, claim age, lease loss, admission saturation, submit latency, commit latency, MVCC conflicts, UNKNOWN age, reconciliation outcomes, and retry exhaustion. Logs must not contain private keys, raw evidence, or customer payloads.

Every decision should be bound to one release SHA and retained in immutable evidence storage. The evidence package should include the migration digest, queue configuration, benchmark output, commit-status behavior, conflict results, partition declaration, reconciliation query, and independent approvals.

## Slide 10 — Production decision

The architecture is technically fail-closed and the local tests cover deterministic identity, partition behavior, context cancellation, duplicate handling, and bounded admission. The remaining production gate is real-network evidence: independent Fabric organizations, approved endorsement policy, HSM-backed identities, orderer and peer commit measurements, concurrent duplicate submissions, partition recovery, PostgreSQL contention tests, and immutable release approval.

The final message to stakeholders is that the queue does not make Fabric the financial ledger. It makes the attestation path durable, bounded, observable, and safe when Fabric is slow or ambiguous.
