# UmojaRetentionWorkerSecurityFailureBurst Incident Response Playbook

## Trigger

This playbook applies when Prometheus fires:

```text
UmojaRetentionWorkerSecurityFailureBurst
```

The alert means that at least three OpenSearch authentication or authorization failures were observed for the retention delete worker during a ten-minute window. Treat it as both an availability incident and a potential identity or privilege-control incident.

The worker must remain fail-closed. Do not broaden the OpenSearch role, disable certificate validation, bypass PostgreSQL authorization claiming, or manually delete an index to restore service.

## Automated response objective

The response automation should:

1. Capture alert and metric evidence.
2. Determine whether failures are TLS/authentication failures or HTTP 403 authorization failures.
3. Pause automated deletion authorization consumption if identity integrity is uncertain.
4. Preserve PostgreSQL authorization and index-manifest records.
5. Verify whether the active worker certificate and OpenSearch role mapping agree.
6. Roll back only to a previously validated worker Secret/Deployment revision when the new identity is known to be faulty.
7. Resume deletion only after positive and negative synthetic tests pass.

## Severity and ownership

| Signal | Initial severity | Owner |
|---|---|---|
| Authentication failure burst | Critical/page | Platform security and PKI operators |
| Authorization failure burst | Critical/page | OpenSearch security administrator and service owner |
| Failure paired with unexpected certificate subject | Security incident | Security incident commander |
| Failure paired with deletion execution errors | Critical operational incident | Platform operator and records-retention owner |

## Phase 0: Alertmanager automation

Alertmanager should route the alert to the incident-management system and a response webhook. The webhook must be authenticated, replay-protected, idempotent, and restricted to this alert name and service label.

```yaml
routes:
  - matchers:
      - alertname = "UmojaRetentionWorkerSecurityFailureBurst"
      - service = "retention-delete-worker"
    receiver: umoja-retention-security-response
    group_wait: 0s
    group_interval: 5m
    repeat_interval: 15m

receivers:
  - name: umoja-retention-security-response
    webhook_configs:
      - url: https://incident-automation.security.example/v1/alerts
        send_resolved: true
```

The response endpoint should not directly grant permissions or execute arbitrary shell commands. It should create a signed incident record and invoke a narrowly scoped runbook job with an allow-listed action set.

## Phase 1: Capture evidence

The automation records the alert payload, Prometheus query results, worker pod identities, deployment revision, certificate Secret resource version, and recent OpenSearch security audit events.

```bash
mkdir -p "evidence/${INCIDENT_ID}"

curl --fail-with-body --silent --show-error \
  "$PROMETHEUS_URL/api/v1/query?query=up%7Bjob%3D%22umoja-retention-worker%22%7D" \
  > "evidence/${INCIDENT_ID}/worker-up.json"

curl --fail-with-body --silent --show-error \
  "$PROMETHEUS_URL/api/v1/query?query=increase(umoja_retention_worker_failures_total%7Bjob%3D%22umoja-retention-worker%22%7D%5B10m%5D)" \
  > "evidence/${INCIDENT_ID}/worker-failures.json"

kubectl -n security get pods \
  -l app.kubernetes.io/name=umoja-retention-worker -o wide \
  > "evidence/${INCIDENT_ID}/pods.txt"

kubectl -n security rollout history deployment/umoja-retention-worker \
  > "evidence/${INCIDENT_ID}/rollout-history.txt"

kubectl -n security get secret umoja-retention-opensearch-client-tls \
  -o jsonpath='{.metadata.resourceVersion}{"\n"}' \
  > "evidence/${INCIDENT_ID}/tls-secret-resource-version.txt"
```

Do not export private keys, bearer tokens, HMAC secrets, or raw customer/payment data into the evidence bundle.

## Phase 2: Classify the failure

Use Prometheus to separate the failure classes:

```promql
increase(umoja_retention_worker_failures_total{
  job="umoja-retention-worker",
  result="opensearch_authentication_failure"
}[10m])

increase(umoja_retention_worker_failures_total{
  job="umoja-retention-worker",
  result="opensearch_authorization_failure"
}[10m])

increase(umoja_retention_worker_failures_total{
  job="umoja-retention-worker",
  result="delete_execution_error"
}[10m])
```

### Authentication/TLS failure

Typical causes include an expired certificate, wrong client key, incomplete chain, untrusted issuing CA, OpenSearch client-authentication failure, hostname/CA mismatch, or a secret mounted with the wrong version.

### Authorization failure

Typical causes include a missing or incorrect certificate-subject mapping, role configuration not applied, the worker using the wrong certificate identity, an index-pattern mismatch, or an attempted operation outside the approved permission set.

A 403 should not be resolved by granting cluster-wide permissions. Compare the requested path with the approved role:

```text
indices:monitor/settings/get
indices:admin/delete
```

## Phase 3: Containment

If authentication failures are present, pause automated deletion worker rollout and stop issuing new deletion jobs. Existing PostgreSQL authorization rows remain intact; do not delete or rewrite them.

If authorization failures are present, pause the delete worker deployment or isolate it from OpenSearch until the role mapping is reviewed. Do not remove the role mapping or rotate the HMAC secret as an improvised fix unless compromise is suspected and the incident commander approves it.

A safe Kubernetes containment action is to pause the Deployment rollout:

```bash
kubectl -n security rollout pause deployment/umoja-retention-worker
```

If the active certificate identity is unknown or suspected compromised, scale the worker to zero only after confirming that no approved deletion is mid-execution and that the retention owner accepts the operational impact:

```bash
kubectl -n security scale deployment/umoja-retention-worker --replicas=0
```

Scaling down prevents further deletion attempts but does not revoke already-issued tokens. Token TTL and PostgreSQL single-use claiming remain effective.

## Phase 4: Diagnose certificate and mapping state

Inspect only public certificate metadata:

```bash
kubectl -n security get secret umoja-retention-opensearch-client-tls \
  -o jsonpath='{.data.tls\.crt}' \
  | base64 -d \
  | openssl x509 -noout -subject -issuer -serial -fingerprint -sha256 -dates
```

Compare the subject and serial with the approved certificate inventory and the OpenSearch `roles_mapping.yml` entry. Confirm that the worker Secret contains a matching certificate and private key:

```bash
kubectl -n security get secret umoja-retention-opensearch-client-tls \
  -o jsonpath='{.data.tls\.crt}' | base64 -d > /tmp/worker.crt
kubectl -n security get secret umoja-retention-opensearch-client-tls \
  -o jsonpath='{.data.tls\.key}' | base64 -d > /tmp/worker.key

openssl x509 -noout -modulus -in /tmp/worker.crt | openssl sha256
openssl rsa -noout -modulus -in /tmp/worker.key | openssl sha256
rm -f /tmp/worker.crt /tmp/worker.key
```

Verify the chain against the OpenSearch client CA using a controlled workstation or ephemeral diagnostic pod. Never copy private keys into incident tickets or chat.

## Phase 5: Safe rollback

Rollback is permitted only to a previously validated Deployment revision and Secret version. First confirm that the old certificate identity remains trusted and mapped in OpenSearch. Then:

```bash
kubectl -n security rollout undo deployment/umoja-retention-worker
kubectl -n security rollout status deployment/umoja-retention-worker --timeout=10m
```

If the Secret itself was rotated incorrectly, restore the prior secret-manager version through the approved secret process, then perform another rolling update. Do not patch certificate bytes directly into a live pod.

After rollback, verify:

```bash
kubectl -n security get pods -l app.kubernetes.io/name=umoja-retention-worker
kubectl -n security rollout status deployment/umoja-retention-worker --timeout=5m
```

Run the mTLS canary:

```bash
NAMESPACE=security \
SECRET_NAME=umoja-retention-opensearch-client-tls \
OPENSEARCH_URL=https://opensearch.security.svc.cluster.local:9200 \
TEST_INDEX=umoja-security-audit-v1-000001 \
./scripts/infra/verify_retention_worker_mtls_canary.sh
```

## Phase 6: Validate least privilege and recovery

Before resuming automated deletion, perform all of the following against synthetic staging data:

| Test | Expected result |
|---|---|
| Exact settings read with current certificate | Success |
| Exact approved-index delete with valid authorization | Success |
| Active legal hold | Denied; no deletion |
| Invalid WORM digest/signature | Denied; no deletion |
| Wildcard delete | HTTP 403 or worker-side rejection |
| ISM policy modification | HTTP 403 |
| Alias mutation | HTTP 403 |
| Unrelated-index deletion | HTTP 403 |
| Old/revoked certificate | TLS/authentication failure |
| Replayed authorization | PostgreSQL claim rejection |

Confirm the following Prometheus conditions before unpausing:

```promql
sum(increase(umoja_retention_worker_failures_total{
  job="umoja-retention-worker",
  result=~"opensearch_authentication_failure|opensearch_authorization_failure"
}[15m])) == 0

min(up{job="umoja-retention-worker"}) == 1

min(umoja_retention_worker_health{job="umoja-retention-worker"}) == 1
```

Because the worker is horizontally deployed, require every expected target to be healthy, not merely one replica.

## Phase 7: Recovery and closure

Resume the Deployment only after the service owner and security reviewer approve the evidence:

```bash
kubectl -n security rollout resume deployment/umoja-retention-worker
kubectl -n security rollout status deployment/umoja-retention-worker --timeout=10m
```

Do not immediately clear the incident. Observe one complete retention-worker operating window and confirm that no new security-failure alerts occur. Reconcile PostgreSQL authorization rows with OpenSearch execution records, especially any authorization that was claimed before the incident.

Close the incident only when:

- the root cause is documented;
- the certificate and role-mapping state are known;
- no unauthorized deletion occurred;
- all denied cases remained denied;
- any claimed-but-unexecuted authorizations were reconciled;
- certificate or role changes are recorded with independent approval; and
- the evidence bundle is stored immutably.

## Automation safety constraints

The incident automation must be idempotent. A repeated alert must not repeatedly scale the deployment, rotate secrets, or create duplicate incident records. Every automated action must be bound to an incident ID and recorded with the actor, timestamp, command/API request, result, and correlation ID.

The automation may pause, collect evidence, run read-only diagnostics, and roll back to an approved revision. It must not grant new OpenSearch permissions, disable TLS verification, delete indexes directly, remove legal holds, or bypass the PostgreSQL authorization store.
