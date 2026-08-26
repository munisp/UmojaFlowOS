# Threat Model Analysis: Privilege Escalation in the Retention Deletion Architecture

## 1. Scope and System Boundary

This analysis evaluates the potential privilege escalation paths between the **OpenSearch ISM Retention Delete Worker** and the **PostgreSQL Authorization Store**. The system boundary includes the cryptographic binding (HMAC), the transport identity (mTLS), and the durable state (PostgreSQL).

### Core Components
- **Retention Worker:** A Python-based service responsible for claiming authorizations and executing deletions.
- **PostgreSQL:** The source of truth for deletion authorizations, index manifests, and incident logs.
- **OpenSearch:** The data plane where indices are physically deleted.

---

## 2. Identified Threat Actors

| Actor | Motivation | Capability |
|---|---|---|
| **Compromised Worker** | Unauthorized data destruction | Access to mTLS certs, HMAC secret, and DB connection. |
| **Malicious DBA** | Hide evidence or DoS | Direct write access to PostgreSQL tables. |
| **Compromised Monitoring** | Trigger false containment | Ability to send signed Alertmanager webhooks. |
| **Network Attacker** | Intercept/Replay | Ability to observe traffic (mitigated by mTLS). |

---

## 3. Privilege Escalation Paths

### Path A: State Tampering (PostgreSQL to OpenSearch)
**Scenario:** A malicious actor with direct database access modifies the `retention_index_manifest` table.
- **Mechanism:** By altering the `archive_digest` for a specific index, the attacker can cause the worker to delete an index that does **not** match the verified WORM archive.
- **Impact:** Permanent loss of audit data that has not been correctly archived or verified.
- **Mitigation:** The worker re-reads the physical index identity (UUID/Version) immediately before deletion. However, the digest lookup remains a dependency.
- **Recommendation:** Implement cryptographic signing of manifest rows or use a separate, immutable WORM-backed manifest service.

### Path B: Token Reuse and Race Conditions
**Scenario:** A compromised worker attempts to reuse an authorization token (Replay Attack).
- **Mechanism:** If the PostgreSQL `SELECT ... FOR UPDATE` claim logic is flawed or if the database is in a "Read Committed" isolation level that allows non-repeatable reads during high concurrency.
- **Impact:** An authorized deletion token could be used multiple times, potentially targeting replaced indices if the name is reused.
- **Mitigation:** Atomic `UPDATE ... WHERE consumed_at IS NULL` ensures only one worker succeeds.
- **Recommendation:** Enforce `SERIALIZABLE` isolation level for authorization claim transactions.

### Path C: Credential Escalation (Worker to Database)
**Scenario:** The worker's database role is over-privileged.
- **Mechanism:** If the worker role can modify its own authorization records or the incident logs.
- **Impact:** A compromised worker could "self-approve" by inserting rows into `retention_delete_authorizations` or hide its own failures by deleting rows from `retention_incident_events`.
- **Mitigation:** Least-privilege RBAC. The worker role should only have `SELECT` on manifests and `SELECT/UPDATE` on authorizations.
- **Recommendation:** Use separate database roles for the **Gateway** (Writer) and the **Worker** (Claimer/Reader).

### Path D: Identity Hijacking (mTLS to OpenSearch)
**Scenario:** The worker's mTLS certificate is used to perform unauthorized OpenSearch operations.
- **Mechanism:** If the OpenSearch RBAC for the worker role is too broad (e.g., allowing wildcard deletes).
- **Impact:** An attacker with the worker's certificate could bypass the PostgreSQL authorization gate entirely and delete any index matching the pattern.
- **Mitigation:** Restricted OpenSearch role mapping to `indices:admin/delete` on specific patterns only.
- **Recommendation:** OpenSearch should require a custom header or metadata containing the PostgreSQL `decision_digest` to be verified by a security plugin (Defense-in-depth).

---

## 4. Risk Matrix

| Threat | Likelihood | Impact | Risk Level |
|---|---|---|---|
| Manifest Digest Tampering | Low | High | **High** |
| Token Replay (Race Condition) | Medium | Medium | **Medium** |
| Database Role Escalation | Low | High | **Medium** |
| Alert Webhook Spoofing | Low | Low | **Low** |

---

## 5. Security Control Validation

### Implemented Controls
1. **HMAC-SHA256 Binding:** Cryptographically binds authorization to the exact index identity and digest.
2. **mTLS Transport:** Ensures only the authenticated worker can talk to OpenSearch.
3. **PostgreSQL Atomic Claims:** Prevents replay and duplicate execution.
4. **Fail-Closed Logic:** Any uncertainty in identity, scope, or evidence results in denial.

### Residual Gaps
1. **Database-Side Manifest Integrity:** The `archive_digest` in PostgreSQL is a single point of failure for verification.
2. **Clock Dependency:** Both HMAC expiry and Chaos Mesh tests show sensitivity to clock skew.

---

## 6. Final Assessment

The architecture provides strong **horizontal isolation** (separating the signal from the authority) and **vertical isolation** (separating the identity from the permission). The primary escalation risk lies in the **integrity of the PostgreSQL manifest**. By hardening the database role and ensuring manifest rows are immutable or signed, the system achieves a production-ready security posture for CBN VASP compliance.
