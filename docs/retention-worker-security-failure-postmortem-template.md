# UmojaRetentionWorkerSecurityFailureBurst Post-Mortem and Recovery Checklist

## Document control

| Field | Value |
|---|---|
| Incident ID | `INC-YYYYMMDD-NNN` |
| Alert | `UmojaRetentionWorkerSecurityFailureBurst` |
| Severity | Critical / Security incident |
| Incident commander |  |
| Detection time UTC |  |
| Mitigation time UTC |  |
| Recovery time UTC |  |
| Closure time UTC |  |
| Independent reviewer |  |
| Change or certificate ticket |  |

## Executive summary

**What happened:**

[State whether the incident involved TLS authentication failures, HTTP 403 authorization failures, certificate rotation, OpenSearch role mapping, network instability, or suspected identity compromise.]

**Impact:**

[State the affected worker replicas, time window, deletion requests delayed or rejected, and whether any unauthorized deletion occurred. Do not include raw customer or payment data.]

**Outcome:**

[State the containment, recovery, and whether the incident is closed or remains under review.]

## Timeline

| Time UTC | Event | Actor/system | Evidence reference |
|---|---|---|---|
|  | Alert fired | Prometheus/Alertmanager |  |
|  | Incident acknowledged |  |  |
|  | Evidence capture started |  |  |
|  | Automated containment completed |  |  |
|  | Certificate/role diagnosis completed |  |  |
|  | Rollback or corrective deployment completed |  |  |
|  | Synthetic positive/negative tests passed |  |  |
|  | Recovery approved |  |  |

## Technical classification

Mark all that apply:

- [ ] `opensearch_authentication_failure`: TLS, certificate, CA, connection, HTTP 401, or proxy-authentication failure.
- [ ] `opensearch_authorization_failure`: HTTP 403 from OpenSearch.
- [ ] `delete_execution_error`: OpenSearch operation failed after authorization claim.
- [ ] Certificate rotation overlap or rollback.
- [ ] OpenSearch role or role-mapping drift.
- [ ] Network partition or service outage.
- [ ] Suspected credential or certificate compromise.
- [ ] Monitoring or instrumentation defect.

## Evidence captured

The evidence bundle must exclude private keys, bearer tokens, HMAC secrets, and unnecessary personal or payment data.

- [ ] Alertmanager payload and alert fingerprint.
- [ ] Prometheus `up`, health, failure, latency, and result queries.
- [ ] Worker pod names, readiness, image digests, and rollout revision.
- [ ] Certificate subject, issuer, serial, SHA-256 fingerprint, and validity window.
- [ ] Secret resource version—not secret contents.
- [ ] OpenSearch security audit records showing the certificate identity and denied/accepted action.
- [ ] OpenSearch role and role-mapping revision.
- [ ] PostgreSQL authorization and execution-status reconciliation.
- [ ] mTLS canary output.
- [ ] Chaos or network evidence if applicable.
- [ ] Recovery and rollback commands with timestamps and operators.

Evidence path: `______________________________`

## Authorization and data-integrity assessment

| Question | Result | Evidence |
|---|---|---|
| Were any indexes deleted without a valid authorization token? |  |  |
| Were any active legal holds bypassed? |  |  |
| Were any WORM verification failures treated as approval? |  |  |
| Were any PostgreSQL authorizations claimed more than once? |  |  |
| Were any claimed-but-unexecuted authorizations reconciled? |  |  |
| Did any role mapping grant permissions beyond the approved role? |  |  |
| Did the exact physical index UUID/version/digest remain bound? |  |  |

## Root cause analysis

**Primary root cause:**

[Describe the technical root cause in one sentence.]

**Contributing conditions:**

[Certificate lifecycle, trust bundle, role mapping, deployment sequencing, network policy, monitoring, or process conditions.]

**Why existing controls did or did not prevent impact:**

[Discuss mTLS, OpenSearch RBAC, PostgreSQL row locking, HMAC authorization, WORM/legal-hold checks, Prometheus alerts, and the canary.]

**Five whys:**

1. Why did the worker security-failure alert fire?
   **Answer:**
2. Why did that condition arise?
   **Answer:**
3. Why was it not prevented before deployment?
   **Answer:**
4. Why did detection or recovery take the observed time?
   **Answer:**
5. What systemic change prevents recurrence?
   **Answer:**

## Recovery checklist

### Immediate containment

- [ ] Acknowledge the alert and assign an incident commander.
- [ ] Preserve the alert fingerprint and evidence directory.
- [ ] Pause the worker rollout.
- [ ] Stop issuing new deletion jobs if identity integrity is uncertain.
- [ ] Do not broaden OpenSearch roles or disable TLS verification.
- [ ] Do not manually delete indexes or bypass PostgreSQL authorization claims.
- [ ] Keep legal holds and WORM retention controls unchanged.

### Identity and authorization verification

- [ ] Confirm the active worker certificate subject and fingerprint.
- [ ] Confirm the certificate chain and validity window.
- [ ] Confirm certificate/private-key match without exposing the key.
- [ ] Confirm OpenSearch trusts the issuing CA.
- [ ] Confirm the exact subject maps to `umoja_retention_delete_worker`.
- [ ] Confirm the role permits only `indices:monitor/settings/get` and `indices:admin/delete` for the audit pattern.
- [ ] Confirm wildcard, alias, ISM-policy, unrelated-index, and Security API operations remain denied.

### Rollback or correction

- [ ] Identify a previously validated Deployment and Secret revision.
- [ ] Confirm the old certificate remains trusted before rollback.
- [ ] Execute the approved rolling rollback.
- [ ] Confirm every expected worker replica is Ready.
- [ ] Re-run the mTLS canary.
- [ ] Reconcile every authorization claimed during the incident window.

### Recovery validation

- [ ] Exact settings read succeeds with the approved certificate.
- [ ] Synthetic authorized deletion succeeds only for the disposable test index.
- [ ] Active-hold test returns `409` and leaves the index present.
- [ ] Invalid-WORM test returns `412` and leaves the index present.
- [ ] Replayed authorization is rejected.
- [ ] Old/revoked certificate fails authentication.
- [ ] Prometheus security-failure counters remain zero during the observation window.
- [ ] Alert resolves only after the underlying failure is gone.
- [ ] OpenSearch and PostgreSQL audit evidence is complete.

## Corrective actions

| Action | Owner | Priority | Due date | Verification | Status |
|---|---|---:|---|---|---|
|  |  | P0 |  |  | Open |
|  |  | P1 |  |  | Open |
|  |  | P2 |  |  | Open |

## Closure approval

The incident may be closed only after the service owner, security owner, records-retention owner, and independent reviewer confirm that no unauthorized deletion occurred, all claimed authorizations were reconciled, the worker identity is correct, least privilege remains intact, and the evidence bundle is immutable.

| Approval role | Name | Signature/date |
|---|---|---|
| Incident commander |  |  |
| Security owner |  |  |
| Service owner |  |  |
| Records-retention owner |  |  |
| Independent reviewer |  |  |
