# Retention Delete Worker mTLS Certificate Rotation Runbook

## Purpose

This runbook rotates the OpenSearch delete worker’s client certificate and private key without interrupting authorized deletion processing. It uses a **dual-trust overlap**: OpenSearch trusts both the old and new worker certificate authorities or certificate identities during the rollout, while the worker replicas are restarted gradually so at least one healthy replica remains available.

The procedure assumes:

- at least two worker replicas;
- Kubernetes Secret-based certificate delivery or an equivalent secret manager;
- OpenSearch HTTP TLS with client authentication required;
- the worker’s OpenSearch role mapping is based on an exact certificate subject or approved certificate identity;
- deletion authorization remains in PostgreSQL and is not recreated during certificate rotation; and
- the old certificate is not revoked until all workers and clients have been confirmed on the new certificate.

## Roles and change controls

The certificate issuer, OpenSearch security administrator, Kubernetes operator, and deletion-worker service owner should be separate responsibilities where segregation of duties requires it. Record the change ticket, certificate serial numbers, subjects, fingerprints, validity windows, approvers, deployment revisions, verification results, and retirement timestamp in the immutable operations evidence stream.

| Role | Responsibility |
|---|---|
| PKI operator | Issues the new client certificate and records its fingerprint |
| OpenSearch security administrator | Adds the new certificate identity to the restricted role mapping |
| Platform operator | Updates the secret and performs the rolling deployment |
| Service owner | Runs functional and authorization validation |
| Independent reviewer | Confirms old-certificate retirement and evidence completeness |

## Preconditions

Before changing anything, confirm:

1. The worker deployment has at least two ready replicas and a PodDisruptionBudget that preserves one available replica.
2. OpenSearch is healthy and the worker can currently read exact index identity and perform an approved synthetic deletion.
3. PostgreSQL authorization rows and index-manifest rows are backed up and reconciled.
4. The new certificate contains the expected client-authentication usage and exact subject/SAN required by the OpenSearch mapping.
5. The new private key is protected by the secret manager and is never written to Git, logs, command history, or a ConfigMap.
6. The new certificate validity starts before the rollout window and ends after the planned next rotation window.
7. OpenSearch is configured to trust both old and new client identities during the overlap.
8. Prometheus alerts for worker availability, authentication failures, authorization failures, and deletion execution errors are active.

Capture the current state:

```bash
kubectl -n security get deployment umoja-retention-worker -o wide
kubectl -n security get pods -l app.kubernetes.io/name=umoja-retention-worker
kubectl -n security get secret umoja-retention-opensearch-client-tls -o jsonpath='{.metadata.resourceVersion}{"\n"}'
kubectl -n security rollout status deployment/umoja-retention-worker --timeout=5m
```

## Phase 1: Issue and inspect the new certificate

Generate or request the certificate through the approved PKI. The certificate should use a dedicated identity such as `umoja-retention-delete-worker-v2`, or use the same stable subject only if the PKI and OpenSearch mapping policy explicitly support seamless serial rotation.

Inspect it without exposing the private key:

```bash
openssl x509 -in worker-v2.crt -noout \
  -subject -issuer -serial -fingerprint -sha256 -dates -text \
  | grep -E 'Subject:|Issuer:|Serial Number:|SHA256 Fingerprint:|Not Before:|Not After:|TLS Web Client Authentication'
```

Verify the certificate chain:

```bash
openssl verify -CAfile opensearch-client-ca.pem worker-v2.crt
```

The private key must match the certificate:

```bash
openssl x509 -noout -modulus -in worker-v2.crt | openssl sha256
openssl rsa  -noout -modulus -in worker-v2.key | openssl sha256
```

The two digests must match. Restrict the local key file while preparing the secret:

```bash
chmod 0400 worker-v2.key
```

## Phase 2: Add the new identity to OpenSearch

Add the new certificate subject to the same least-privilege role mapping while retaining the old subject. Do not grant a broader role during the overlap.

Example temporary mapping:

```yaml
umoja_retention_delete_worker:
  reserved: false
  hidden: false
  backend_roles: []
  hosts: []
  users:
    - "CN=umoja-retention-delete-worker-v1,OU=Platform Security,O=UmojaFlowOS,L=Lagos,ST=Lagos,C=NG"
    - "CN=umoja-retention-delete-worker-v2,OU=Platform Security,O=UmojaFlowOS,L=Lagos,ST=Lagos,C=NG"
```

If the cluster validates client certificates against a client CA rather than direct subjects, add the new issuing CA to the trust bundle through the approved OpenSearch configuration process. Keep the old CA during the overlap.

Apply the role mapping with the OpenSearch Security administration identity, not the retention worker certificate. Confirm the mapping through the Security API or the approved `securityadmin.sh` workflow. Save the response and configuration revision as evidence.

## Phase 3: Validate the new certificate before deployment

From a controlled staging host, use the new certificate to perform a harmless metadata read:

```bash
curl --fail-with-body \
  --cert worker-v2.crt \
  --key worker-v2.key \
  --cacert opensearch-ca.pem \
  "$OPENSEARCH_URL/umoja-security-audit-v1-000001/_settings/index.uuid,index.version"
```

Confirm that the new certificate is denied access to unrelated operations:

```bash
curl -sS -o /tmp/forbidden.json -w '%{http_code}\n' \
  --cert worker-v2.crt --key worker-v2.key --cacert opensearch-ca.pem \
  -X PUT "$OPENSEARCH_URL/_plugins/_ism/policies/umoja-security-audit-v1-retention"
```

The expected result is `403`. Also test that wildcard deletion, alias mutation, and Security API access are denied.

## Phase 4: Publish the new Kubernetes Secret

Update the TLS secret through the secret manager or an external-secrets controller. If using a direct Kubernetes Secret for staging, create a new version rather than printing secret values:

```bash
kubectl -n security create secret tls umoja-retention-opensearch-client-tls-v2 \
  --cert=worker-v2.crt \
  --key=worker-v2.key \
  --dry-run=client -o yaml \
  | kubectl apply -f -
```

The production pattern should use an external-secrets resource and should not place certificate bytes in a Git-tracked manifest. Confirm the Secret has the expected resource version and that access is limited to the worker’s namespace and service account path.

## Phase 5: Rolling deployment without downtime

Reference the new Secret in the Deployment and trigger a rolling update. The Deployment must use a readiness probe, `maxUnavailable: 0`, and a bounded `maxSurge`:

```yaml
strategy:
  type: RollingUpdate
  rollingUpdate:
    maxUnavailable: 0
    maxSurge: 1
```

Update only the secret reference or mounted projected-secret version, then monitor the rollout:

```bash
kubectl -n security rollout status deployment/umoja-retention-worker --timeout=10m
kubectl -n security get pods -l app.kubernetes.io/name=umoja-retention-worker -o wide
kubectl -n security get events --sort-by=.lastTimestamp | tail -50
```

The new pod must pass its readiness probe before Kubernetes terminates an old pod. During the overlap, old and new worker pods may both process requests; PostgreSQL’s atomic authorization claim prevents duplicate token consumption.

If the secret is mounted using a projected volume that updates in place, restart pods in a controlled rolling deployment anyway. This ensures the Python process and its TLS connection pool load the new key and certificate.

## Phase 6: Functional and security validation

Run these checks while monitoring Prometheus:

1. Confirm all replicas become Ready.
2. Confirm `umoja_retention_worker_health` remains `1`.
3. Confirm `up{job="umoja-retention-worker"}` remains `1` for every expected target.
4. Confirm no `UmojaRetentionWorkerOpenSearchAuthenticationFailure` alert fires.
5. Confirm no `UmojaRetentionWorkerOpenSearchAuthorizationFailure` alert fires.
6. Execute a synthetic, fully authorized deletion against a disposable index.
7. Execute an active-hold test and confirm HTTP `409` with no deletion.
8. Execute an invalid-WORM test and confirm HTTP `412` with no deletion.
9. Confirm the worker certificate subject in OpenSearch security audit logs.
10. Confirm a wildcard or unrelated-index delete remains forbidden.
11. Confirm a repeated authorization is rejected by PostgreSQL single-use claiming.
12. Confirm existing PostgreSQL authorization and manifest rows remain unchanged except for expected execution status.

Prometheus queries useful during the rollout are:

```promql
up{job="umoja-retention-worker"}

sum by (result) (
  increase(umoja_retention_worker_failures_total{job="umoja-retention-worker"}[10m])
)

increase(umoja_retention_worker_failures_total{
  job="umoja-retention-worker",
  result="opensearch_authentication_failure"
}[5m])

increase(umoja_retention_worker_failures_total{
  job="umoja-retention-worker",
  result="opensearch_authorization_failure"
}[5m])
```

## Phase 7: Retire the old certificate

Do not revoke or remove the old certificate immediately after the first new pod is healthy. Wait until:

- every worker pod reports the new certificate fingerprint through approved diagnostics;
- at least one complete rotation observation window has passed;
- no old pods remain;
- active connections using the old certificate have drained or expired;
- the synthetic positive and negative tests have passed; and
- an independent reviewer has approved retirement.

Then remove the old subject from `roles_mapping.yml` or remove the old issuing CA from the OpenSearch trust bundle. Re-apply the configuration and confirm the old certificate receives TLS/authentication failure or authorization denial, while the new certificate continues to work.

After the overlap, revoke or disable the old certificate in the PKI and update the certificate inventory with its retirement timestamp. Preserve the old public certificate and fingerprint for audit evidence, but securely destroy the old private key according to key-management policy.

## Rollback procedure

If new pods fail readiness, OpenSearch returns 401/403, TLS handshakes fail, or deletion-worker errors increase:

1. Stop the rollout:

   ```bash
   kubectl -n security rollout pause deployment/umoja-retention-worker
   ```

2. Keep the old certificate subject and old CA trusted in OpenSearch.
3. Restore the previous Secret reference or Deployment revision:

   ```bash
   kubectl -n security rollout undo deployment/umoja-retention-worker
   kubectl -n security rollout status deployment/umoja-retention-worker --timeout=10m
   ```

4. Confirm old workers are healthy and synthetic deletion is functioning.
5. Do not consume new authorizations merely to test the rollback; use a disposable authorization and index.
6. Investigate certificate chain, subject mapping, CA bundle, file permissions, service-account secret access, and OpenSearch audit logs.
7. Revoke the new certificate only after confirming no healthy worker still depends on it.

If an authorization was claimed immediately before a failed delete execution, do not bypass the consumed state. Reconcile the exact physical index and PostgreSQL execution status before any retry.

## Emergency response and evidence

A certificate authentication failure is a security and availability incident. Page the on-call team for any authentication-failure alert, authorization-failure burst, or deletion execution error. Freeze automated deletion if the worker identity or OpenSearch role mapping cannot be established.

The final evidence bundle should include the change ticket, old/new certificate fingerprints, role-mapping diff, CA-bundle revision, Secret resource versions, rollout history, Prometheus screenshots or query results, OpenSearch audit events, synthetic test results, rollback status, and independent approval.

## Completion criteria

The rotation is complete only when all replicas use the new certificate, OpenSearch maps the new identity to the unchanged least-privilege role, the old identity is removed or revoked, no security-failure alerts fired during the observation window, positive and negative deletion tests passed, and the evidence bundle has been independently reviewed.
