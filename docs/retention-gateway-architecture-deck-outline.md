# OpenSearch ISM Retention Delete Gateway — Slide Content

## Cover
OpenSearch ISM Retention Delete Gateway
Fail-closed deletion, mTLS identity, immutable evidence, and Chaos Mesh validation
UmojaFlowOS · Production-readiness architecture review

## Slide 1
### Retention deletion is a gated control plane
- OpenSearch ISM requests lifecycle actions; it is not the sole deletion authority.
- The retention gateway evaluates holds, WORM evidence, completeness, approvals, and scope.
- A separate worker executes only a short-lived, exact-index authorization.
- Unknown, stale, or failed checks deny deletion.

## Slide 2
### The delete path has independent trust boundaries
- Alert/ISM request: lifecycle signal, not authorization.
- PostgreSQL: durable authorization registration and single-use claim.
- WORM/archive provider: independent digest, signature, completeness, and retain-until evidence.
- OpenSearch: exact physical-index identity recheck and delete execution.

## Slide 3
### HMAC binds authorization to one physical index
- Canonical payload includes index name, UUID, version, archive digest, decision digest, and expiry.
- Worker validates timestamp, HMAC-SHA256, constant-time comparison, and exact scope.
- PostgreSQL row locking allows one claim; replay is denied.
- Index replacement, digest drift, or expired tokens cannot be reused.

## Slide 4
### mTLS proves worker identity; RBAC limits its blast radius
- Worker validates the OpenSearch CA and presents a client certificate/private key.
- Certificate subject maps to `umoja_retention_delete_worker`.
- Role grants only settings inspection and physical-index deletion on `umoja-security-audit-v1-*`.
- No cluster administration, ISM mutation, alias mutation, wildcard deletion, or unrelated-index access.

## Slide 5
### ISM moves immutable evidence from hot to warm to delete
- Hot: write alias, rollover at 25 GB or one day.
- Warm: after seven days, one replica and read-only state.
- Delete: after 365 days, retention gateway notification then deletion.
- Legal holds and WORM verification must remain an external fail-closed gate.

## Slide 6
### Observability turns security failures into pages
- Worker exports request, result, failure, latency, and health metrics.
- Prometheus separates TLS/authentication failures from HTTP 403 authorization failures.
- Alertmanager pages on any security failure and bursts of three or more in ten minutes.
- Evidence capture records alert payload, rollout state, pods, Secret version, and security events without secrets.

## Slide 7
### Canary and chaos tests validate the failure model
- Canary verifies certificate chain, expiry window, OpenSearch identity read, and expected 403 denial.
- TimeChaos simulates expired certificate behavior during a real worker execution.
- NetworkChaos partitions worker-to-OpenSearch traffic for a bounded interval.
- Expected outcome: fail closed, preserve authorization state, and perform no unauthorized deletion.

## Slide 8
### Production gates are explicit
- Dual-trust certificate rotation with rolling deployment and rollback.
- Independent WORM/legal-hold evidence before delete authorization.
- PostgreSQL-backed single-use claims and exact-index reconciliation.
- Required sign-off: security, platform, records-retention owner, and independent reviewer.
