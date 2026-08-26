# Operational Runbook: Retention Worker Security Incident Response

## Overview

This runbook defines the automated and manual response procedures for security-related failures in the UmojaFlowOS OpenSearch ISM retention delete worker. It specifically targets the `UmojaRetentionWorkerSecurityFailureBurst` alert, which indicates repeated authentication or authorization failures.

The system uses a fail-closed architecture: if identity or permissions are uncertain, the system denies deletion.

## 1. Incident Response Playbook

### Trigger
- **Alert:** `UmojaRetentionWorkerSecurityFailureBurst`
- **Condition:** &ge; 3 security failures (authentication/authorization) in 10 minutes.
- **Initial Severity:** Critical / Security Incident.

### Automated Containment and Evidence Capture
The automated response service (see Section 2) performs the following immediately upon receiving the alert:
1. **Authenticated Intake:** Verifies the Alertmanager webhook signature using HMAC-SHA256.
2. **Idempotency Check:** Records the incident in PostgreSQL to prevent duplicate processing.
3. **Evidence Snapshot:** Executes allow-listed read-only commands to capture:
   - Pod status and readiness.
   - Deployment state and rollout history.
   - Secret resource versions (metadata only).
   - Metrics and recent failure result labels.
4. **Rollout Pause:** Pauses the worker deployment to prevent further faulty replicas from adopting the identity.

### Manual Recovery Steps
| Step | Action | Command/Verification |
|---|---|---|
| 1 | **Identify Failure Class** | Check Prometheus labels: `opensearch_authentication_failure` vs `opensearch_authorization_failure`. |
| 2 | **Inspect Certificate** | Verify subject, serial, and validity: `kubectl -n security get secret ... -o jsonpath='{.data.tls\.crt}' | base64 -d | openssl x509 -noout -text` |
| 3 | **Verify RBAC** | Confirm `roles_mapping.yml` matches the certificate subject exactly. |
| 4 | **Rollback** | If a rotation failed, revert to the last known good revision: `kubectl -n security rollout undo deployment/umoja-retention-worker` |
| 5 | **Canary Test** | Run the mTLS canary: `./scripts/infra/verify_retention_worker_mtls_canary.sh` |
| 6 | **Reconcile** | Verify PostgreSQL authorization rows against OpenSearch indices. |

---

## 2. Automated Response Service Implementation

The following Python service handles the Alertmanager webhook and executes the automated evidence capture.

```python
# incident_response_service.py
# (Full implementation as provided in simulators/retention_gateway/incident_response_service.py)
# Key features: HMAC signature verification, PostgreSQL idempotency, allow-listed command execution.
```

*(Refer to `simulators/retention_gateway/incident_response_service.py` for the complete source code.)*

---

## 3. Deployment and Operation

### Prerequisites
- **PostgreSQL:** Access to the `umoja` database with permissions to create and manage the `retention_incident_events` table.
- **Kubernetes:** `kubectl` configured with access to the `security` namespace.
- **Secrets:** `INCIDENT_WEBHOOK_SECRET_FILE` containing the 32-byte HMAC secret shared with Alertmanager.

### Configuration Environment Variables
| Variable | Description | Default |
|---|---|---|
| `DATABASE_URL` | PostgreSQL connection string. | (Required) |
| `INCIDENT_WEBHOOK_SECRET_FILE` | Path to the shared HMAC secret. | (Required) |
| `INCIDENT_EVIDENCE_ROOT` | Directory to store captured evidence. | `/var/lib/umoja/incidents` |
| `WORKER_NAMESPACE` | Namespace where the worker is deployed. | `security` |

### Alertmanager Configuration
```yaml
receivers:
  - name: umoja-retention-security-response
    webhook_configs:
      - url: http://retention-incident-service.security.svc.cluster.local:8080/v1/alerts
        http_config:
          # HMAC signature is calculated by Alertmanager or a proxy
          # if native HMAC support is unavailable, use a sidecar.
```

### Verification
To verify the service is operational:
1. **Health Check:** `curl http://<service-url>/healthz`
2. **Metrics:** Scrape `/metrics` to confirm incident registration counts.
3. **Dry Run:** Send a signed synthetic alert payload and verify evidence appears in `INCIDENT_EVIDENCE_ROOT`.

---

## 4. Post-Mortem and Recovery Checklist
Every incident must conclude with a post-mortem. Use the `docs/retention-worker-security-failure-postmortem-template.md` to document the root cause, impact, and corrective actions.

**Recovery Approval:** Closure requires sign-off from:
- Security Owner (Identity integrity)
- Platform Owner (Deployment stability)
- Retention Owner (Legal/WORM compliance)
- Independent Reviewer (Evidence completeness)
