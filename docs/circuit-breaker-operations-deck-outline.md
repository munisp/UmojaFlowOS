# UmojaFlowOS Circuit Breaker Operations

## Slide 1: Fail-closed circuit breaker prevents database cascading failures
- The retention worker implements a state machine (closed → open → half_open) for PostgreSQL connection pool acquisition.
- Three consecutive 2-second pool timeouts force the circuit open, rejecting new claims instantly with HTTP 503.
- This protects PostgreSQL availability by halting retry storms and prevents OpenSearch deletion without a durable authorization claim.
- The circuit allows one half-open recovery probe after 30 seconds; a successful claim closes it, while a failure reopens it.

## Slide 2: Critical lock waits trigger immediate PagerDuty escalation
- Alertmanager routes `UmojaRetentionPostgresLockWaitProductionCritical` directly to the retention PagerDuty service.
- The threshold is strict: any maximum lock wait exceeding 2 seconds for 2 minutes pages the on-call engineer.
- Triage strictly prohibits increasing pool size or disabling mTLS during an incident without database owner approval.
- Recovery requires lock waits to fall below 2 seconds, pool waiters to clear, and ambiguous claims to be reconciled.

## Slide 3: Worker-scoped timeouts enforce burst protection without global impact
- Timeout parameters are applied via connection options, isolating burst protection to the retention worker role.
- The statement timeout (5s) bounds the worker's total execution budget per transaction.
- The lock timeout (1.5s) aborts excessive waits before the statement deadline, preventing localized queueing.
- The idle-in-transaction timeout (10s) terminates abandoned worker transactions before they cause severe table bloat.

## Slide 4: Chaos Mesh tests validate pool saturation and circuit-open transitions
- The weekly staging Chaos Mesh schedule injects a 3-second worker-to-PostgreSQL network delay.
- An automated CronJob drives concurrent synthetic authorizations to intentionally exhaust the 10-connection pool.
- Integration tests verify that the circuit transitions to open, rejects probes, and never reaches an OpenSearch delete.
- This ensures the fail-closed behavior and PagerDuty alerts are continuously verified against actual saturation conditions.
