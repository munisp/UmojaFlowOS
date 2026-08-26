# Speaker Script: Engineering Stakeholder Walkthrough
## Topic: Retention Delete Gateway — Threat Model and Operations

---

### 1. Introduction (1 minute)
**Speaker:** "Good morning, everyone. Today, we’re reviewing the architecture and operational readiness of the UmojaFlowOS Retention Delete Gateway. Our goal is to ensure that our data-destruction processes are as secure and auditable as our data-ingestion processes, specifically meeting the high bar required for CBN VASP compliance."

---

### 2. Architecture Overview (2 minutes)
**Speaker:** "The core of this system is a fail-closed control plane. We don't just 'delete logs.' Instead, we have a multi-stage pipeline. OpenSearch ISM signals when an index is eligible for deletion. That signal is picked up by a Gateway, which evaluates legal holds, WORM evidence, and independent approvals. If everything checks out, it issues a short-lived HMAC-signed token. This token is then consumed by a separate Delete Worker, which re-verifies the exact physical index identity before finally executing the delete."

---

### 3. Threat Model Findings (4 minutes)
**Speaker:** "We conducted a deep-dive threat model focusing on privilege escalation between the Worker and PostgreSQL. We identified four primary risk paths:

**Path A: State Tampering.** We realized that if the database manifest was compromised, an attacker could point a deletion request to unverified data. To mitigate this, we’ve just implemented **Cryptographic Manifest Signing**. Every manifest row is now signed by the Gateway and verified by the Worker.

**Path B: Token Replay.** We use PostgreSQL row-level locking with `SELECT ... FOR UPDATE` to ensure an authorization token can be claimed exactly once. This prevents a compromised worker from deleting the same index multiple times if it were replaced.

**Path C: Credential Escalation.** We’ve implemented strict **Database Role Separation**. The Gateway has a 'Writer' role, and the Worker has a 'Reader/Claimer' role. A compromised worker can no longer self-approve a deletion or tamper with the manifest.

**Path D: Identity Hijacking.** We use mTLS for worker-to-OpenSearch communication. Even if an attacker gets the certificate, they are restricted by a least-privilege RBAC role that only allows settings inspection and exact-index deletion on the audit pattern."

---

### 4. Operational Runbook Walkthrough (3 minutes)
**Speaker:** "Our operational posture is driven by the 'Retention Worker Security Incident Response' runbook. We’ve automated the first few minutes of any security event.

When the `SecurityFailureBurst` alert fires—meaning we’ve seen three or more auth failures in ten minutes—Alertmanager sends a signed webhook to our response service. This service immediately captures pod state, rollout history, and metrics. It then pauses the deployment to contain any potential misconfiguration or identity drift.

From there, the on-call engineer follows the manual recovery steps: identifying the failure class via Prometheus labels, verifying the certificate subject, and running our mTLS canary script before resuming service."

---

### 5. Chaos Validation (2 minutes)
**Speaker:** "Finally, we don't just assume this works. We use Chaos Mesh to prove it. We have automated tests that simulate certificate expiration via clock skew and network partitions. In every test case, the system remained fail-closed—no unauthorized deletions occurred, and the authorization state remained intact. This gives us the evidence we need for regulatory sign-off."

---

### 6. Closing and Q&A (1 minute)
**Speaker:** "In summary, we’ve moved from a simple cleanup script to a cryptographically bound, role-separated, and chaos-tested gateway. I’ll now open the floor for any technical questions on the implementation or the incident response procedures."
