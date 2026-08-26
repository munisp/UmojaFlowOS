# Weekly Staging Chaos Mesh Pool-Saturation Validation

## Scope and schedule

The experiment is restricted to the `security` namespace and resources carrying the retention-worker and PostgreSQL labels. It runs every Sunday at **03:00 UTC** through the Chaos Mesh `Schedule` resource. The validation CronJob starts at **03:02 UTC**, during the bounded ten-minute latency fault window.

| Resource | Schedule | Purpose |
|---|---:|---|
| `umoja-retention-postgres-pool-weekly` | Sunday 03:00 UTC | Injects 3.0 s ± 0.5 s worker-to-PostgreSQL latency for ten minutes |
| `umoja-retention-postgres-pool-weekly-validate` | Sunday 03:02 UTC | Creates synthetic authorizations, validates pool saturation, and writes reports |

## Prerequisites

Confirm the cluster is a staging cluster, Chaos Mesh 2.8.4-compatible CRDs are installed, the Chaos controller manager timezone is UTC, and the worker has the bounded pool settings `min=2`, `max=10`, and `timeout=2s`. Configure an external-secret source for `umoja-retention-chaos-observability`; it must contain `PROMETHEUS_URL` and a read-only `token`.

The validation image must be built from the updated `locust-regression` Dockerfile because it includes the fixture generator, Chaos test, JUnit reporter, and Prometheus report collector.

## Apply and verify

```bash
kubectl apply -f infra/retention-gateway/chaos-mesh/schedule-worker-postgres-pool-saturation-weekly.yaml
kubectl apply -f infra/retention-gateway/chaos-mesh/weekly-pool-saturation-validation-cronjob.yaml

kubectl -n security get schedule umoja-retention-postgres-pool-weekly
kubectl -n security get cronjob umoja-retention-postgres-pool-weekly-validate
```

Before enabling the weekly run, manually create a validation Job from the CronJob during an approved off-peak maintenance window:

```bash
kubectl -n security create job --from=cronjob/umoja-retention-postgres-pool-weekly-validate \
  retention-pool-chaos-manual-$(date +%s)
```

The manual validation must be executed while a matching one-time scheduled fault is active; otherwise it should fail because no pool saturation was observed. This is expected and confirms the report does not report a false pass.

## Pause and resume

Pause the schedule before release freezes, database maintenance, incident response, or when staging is not isolated:

```bash
kubectl -n security annotate schedule umoja-retention-postgres-pool-weekly \
  experiment.chaos-mesh.org/pause=true --overwrite
kubectl -n security patch cronjob umoja-retention-postgres-pool-weekly-validate \
  --type merge -p '{"spec":{"suspend":true}}'
```

Resume only after an independent staging owner confirms the safe window:

```bash
kubectl -n security annotate schedule umoja-retention-postgres-pool-weekly \
  experiment.chaos-mesh.org/pause-
kubectl -n security patch cronjob umoja-retention-postgres-pool-weekly-validate \
  --type merge -p '{"spec":{"suspend":false}}'
```

## Evidence and validation

Each run writes a dedicated timestamped directory on the `umoja-retention-chaos-reports` PVC. It contains the synthetic fixture during execution, JUnit XML, a JSON report, and a Markdown report. The fixture is removed at process exit. Directories older than 90 days are removed by the job; copy required compliance evidence to the approved immutable archive before that boundary.

A run passes only when the Chaos test passes, at least one `database_connection_pool_saturated` failure is visible in Prometheus, the worker remains up, and the target is explicitly staging. A missing metric, failed test, unavailable worker, or failure to observe saturation makes the report nonzero and the CronJob fail.

## References

[1]: https://chaos-mesh.org/docs/define-scheduling-rules/ "Chaos Mesh — Define Scheduling Rules"
[2]: https://chaos-mesh.org/docs/run-a-chaos-experiment/ "Chaos Mesh — Run a Chaos Experiment"
