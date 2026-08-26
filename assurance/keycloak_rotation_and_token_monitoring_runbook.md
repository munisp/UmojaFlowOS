# Keycloak Rotation and Token Compliance Runbook

## Staging validation

Create a protected GitHub environment named `staging-keycloak-rotation`. Configure only staging values in environment variables and secrets. The Vault JWT role `umoja-keycloak-evidence-rotation-staging` must bind the repository, workflow ref, GitHub OIDC issuer, audience, and staging environment claims. Its policy may read only the staging Keycloak admin secret and evidence-publisher secret paths and may update only the evidence-publisher KV path.

The workflow is manually dispatched and uses the canonical `scripts/infra/rotate_keycloak_evidence_secret.sh`. It obtains a new Keycloak client secret, writes a new Vault KV version, uploads an authenticated evidence canary, and invokes the compensating rotation on any failure after the primary rotation becomes active. The final step runs `monitor_keycloak_token_compliance.py --revoke-canary` with a dedicated staging client. A successful run requires all of the following:

| Check | Required result |
|---|---|
| Vault authentication | GitHub OIDC succeeds with staging-only policy |
| Primary rotation | New secret is generated and stored as a new KV version |
| Evidence canary | Gateway accepts the token and exact evidence digest |
| Recovery path | Failure injection in a staging rehearsal results in compensating rotation and a passing recovery canary |
| Token TTL | `KEYCLOAK_MIN_TOKEN_TTL_SECONDS <= expires_in <= KEYCLOAK_MAX_TOKEN_TTL_SECONDS` |
| Introspection | New token is active and issuer/audience match the configured values |
| Revocation | Dedicated canary token is inactive after the revoke request |

Do not use the production client as the revocation canary. A canary client must have no administrative roles, no evidence-publishing role, and no access to production data.

## Continuous monitoring

Run the monitor at a short fixed interval from the production monitoring namespace, using a Kubernetes CronJob or a systemd timer. The process must receive the client secret from Vault-injected memory or a protected file and must never place it in command-line arguments or logs. The monitor returns exit code `1` for any network, token, issuer, audience, TTL, introspection, or revocation failure.

For a node-exporter textfile collector, execute:

```bash
python3 scripts/infra/monitor_keycloak_token_compliance.py \
  --revoke-canary \
  --metrics-file /var/lib/node_exporter/textfile_collector/umoja-keycloak-token-compliance.prom
```

Write to a temporary file on the same filesystem and atomically rename it in the scheduler wrapper. Remove stale metric files when the check cannot complete; otherwise Prometheus may treat old success metrics as current. For a Pushgateway deployment, POST the generated exposition text only from the monitoring namespace and set a bounded job/grouping key such as `job=umoja-keycloak-token-compliance,realm=umoja`.

Use the normal token monitor without `--revoke-canary` only for high-frequency TTL and introspection checks. Run the revocation canary less frequently, such as every 15 minutes, because it intentionally invalidates its token. Both checks must use separate clients.

## Prometheus and Grafana

Load `infra/monitoring/keycloak-token-compliance-alerts.yml` into the Prometheus rule files. The rules are fail-closed: monitor outage, token TTL drift, any compliance failure, disabled revocation coverage, and rollback escalation are alert conditions. Load `infra/monitoring/grafana/keycloak-token-compliance-dashboard.json` into Grafana and configure the Prometheus data source.

The rotation executor should expose these counters from its operational metrics adapter:

```text
umoja_keycloak_rotation_failures_total
umoja_keycloak_rotation_rollback_failures_total
```

The rotation workflow must increment the first counter for a primary failure and the second counter when the compensating rotation or recovery canary fails. These counters must be durable outside the CI runner, for example through a small protected metrics endpoint or an approved Pushgateway. A CI job log alone is not a production monitoring source.

## Incident response

Any critical alert freezes release promotion and evidence publication. Preserve the Vault KV version metadata, workflow run ID, Keycloak event/audit records, gateway request correlation ID, and Prometheus samples. Do not delete or overwrite Vault versions. Security and Operations independently verify whether the primary secret or recovery secret is active before restoring service. Production returns to GO only after the recovery canary, token TTL, introspection, revocation, and four-role release approvals are valid again.
