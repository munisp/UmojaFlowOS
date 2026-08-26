# Speaker Script: UmojaFlowOS Circuit Breaker Operations

**Audience:** Engineering leadership, database operations, platform engineering, and retention-control owners
**Suggested duration:** 8–10 minutes
**Purpose:** Explain how the retention delete worker protects PostgreSQL under burst saturation, how the alerting path escalates incidents, and how the recovery process preserves financial and audit integrity.

## Opening slide — UmojaFlowOS Circuit Breaker Operations

“Today’s objective is to make the operational posture of the retention delete worker clear. This worker has authority only to execute a deletion after a durable, cryptographically scoped authorization passes all gates. PostgreSQL is the authorization source of truth, which means database saturation cannot be treated as a normal availability issue. If PostgreSQL is unhealthy or congested, the correct behavior is to stop safely rather than attempt to continue.

The controls we are reviewing combine a bounded PostgreSQL connection pool, a fail-closed circuit breaker, Prometheus and Alertmanager escalation, and recurring Chaos Mesh validation. The goal is not simply higher throughput. The goal is controlled degradation that preserves integrity, evidence, and recoverability.”

## Slide 1 — Fail-closed circuit breaker prevents database cascading failures

“This slide shows the worker’s circuit breaker state machine. In the normal closed state, the worker can attempt a PostgreSQL authorization claim through its bounded connection pool. The pool acquisition timeout is two seconds. That limit ensures that callers do not accumulate indefinitely while the database is already under pressure.

After three consecutive pool-acquisition timeouts, the breaker opens. From that point, new requests are rejected immediately with HTTP 503 and the explicit result `database_circuit_open`. Importantly, this happens before a new PostgreSQL connection is attempted and before the worker can read or delete anything in OpenSearch.

The operational implication is that we stop retry amplification at the service boundary. We do not mask an unhealthy database by opening more connections. After thirty seconds, the breaker enters half-open and permits one controlled probe. A successful durable claim closes the circuit. A failed probe reopens it. This gives us a clear, observable recovery signal rather than assuming a timeout has recovered.”

**Transition:** “The breaker is the immediate containment control. The next question is how engineering is notified and what they are required to do.”

## Slide 2 — Critical lock waits trigger immediate PagerDuty escalation

“The alerting design distinguishes active lock pressure from a circuit event, but both are critical for the retention path. When maximum PostgreSQL lock wait exceeds two seconds for two minutes, `UmojaRetentionPostgresLockWaitProductionCritical` routes directly to the retention PagerDuty service. Circuit-open state and circuit-open transition alerts use the same urgent paging path.

The first response is disciplined containment. We acknowledge the page, freeze retention configuration changes and scheduled load activity, and capture the worker revision, pool configuration, metrics, and correlation IDs. We then use a privileged read-only operations role to identify waiting sessions and blockers.

There are controls we intentionally do not relax in an incident. We do not increase the pool blindly, disable mTLS, bypass authorization checks, or retry unknown deletion tokens. Each of those actions can turn a capacity problem into an integrity event.

Recovery has evidence gates. Lock waits must be below the threshold, pool waiters must return to baseline, the circuit must close through a successful controlled probe, and affected authorization digests must reconcile to signed manifest and exact index state.”

**Transition:** “To understand why the recovery requirements are strict, we need to look at the resource bounds built into each worker database session.”

## Slide 3 — Worker-scoped timeouts enforce burst protection without global impact

“These timeout values are deliberately scoped to the retention worker’s pooled PostgreSQL sessions. They are not global PostgreSQL changes. The lock timeout is one and a half seconds, the pool acquisition timeout is two seconds, the statement timeout is five seconds, and the idle-in-transaction timeout is ten seconds.

This ordering matters. Lock waits are terminated before the broader statement budget is consumed. If a request cannot acquire a client-pool connection within two seconds, it fails closed. The five-second statement limit prevents a worker query from holding resources indefinitely, and the ten-second idle-in-transaction limit prevents abandoned work from retaining locks or obstructing vacuum.

The worker pool is bounded at ten connections per replica. Increasing that number is not a default remedy. It must be budgeted against all database clients, administrative reserve capacity, and the resource cost of PostgreSQL server connections. Capacity changes are staged, measured, and approved through the retention and database owners.”

**Transition:** “Finally, these controls are not accepted based on code review alone. They are exercised repeatedly in an isolated staging environment.”

## Slide 4 — Chaos Mesh tests validate pool saturation and circuit-open transitions

“This final slide covers our validation loop. Every week, a staging-only Chaos Mesh schedule introduces a bounded three-second delay between the retention worker and PostgreSQL. A separate automated CronJob generates synthetic, short-lived authorization records for nonexistent indices and drives concurrent claims.

The expected outcome is not throughput. The expected outcome is evidence that the pool saturates, the circuit opens after its configured threshold, probe requests receive `database_circuit_open`, and no OpenSearch deletion can occur. The test writes JUnit evidence and queries Prometheus for pool saturation failures, lock wait metrics, worker availability, and circuit state.

This gives us a repeatable proof that the failure path still works after image changes, database configuration changes, certificate rotation, or deployment changes. If the test cannot observe saturation, cannot parse the metrics, or sees an unexpected deletion path, it fails rather than reporting a false pass.

The decision for engineering leadership is straightforward: keep this operating model fail-closed. Treat successful recovery as a measured, reconciled event—not as the absence of an error message.”

## Closing

“To close, the retention worker is designed to protect the authorization source of truth under load. The circuit breaker controls immediate behavior, Prometheus and PagerDuty create accountable escalation, worker-scoped timeouts limit resource consumption, and scheduled Chaos tests prove that the protective behavior remains intact. The next operational action is to apply the alert configuration through the approved staging pipeline, validate route delivery with a PagerDuty test service, and retain the resulting evidence before production activation.”
