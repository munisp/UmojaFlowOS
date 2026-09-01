# Fabric Queue Observability Staging Review

## Scope

This review covers the PostgreSQL 16 contention load-test request, payment-engine Prometheus exporter deployment, Prometheus scrape and Grafana verification, and cross-replica invocation of `RefreshQueueDepth`.

## Environment result

No approved staging Kubernetes context, kubeconfig, Prometheus endpoint, Grafana endpoint, database connection string, or PostgreSQL credentials were present in the execution environment. `psql` was installed, but no `PG*`, `DATABASE_URL`, or staging variables were configured. `kubectl`, `istioctl`, and `promtool` were unavailable. No live deployment, database load, scrape query, or dashboard rendering was therefore attempted.

This is a fail-closed result: the repository does not claim live staging evidence without an authenticated target.

## Exporter implementation

The payment-engine `/metrics` endpoint now includes Fabric queue gauges, admission gauges, queue/lease/reconciliation/MVCC counters, commit timeout counters, and commit-latency histograms. Kubernetes Downward API values `POD_NAMESPACE` and `POD_NAME` are used as safe scrape labels by the staging overlay. Local tests verify both unlabeled exposition and labeled metric formatting.

## RefreshQueueDepth review

Before this change, `RefreshQueueDepth` existed as a method but had no call site in the payment-engine queue-worker composition. That meant local transition counters could be updated while authoritative cross-replica queue gauges remained stale, and an idle replica would not refresh its view.

The implementation now provides `StartQueueDepthRefresher(ctx, db, metrics, interval)`. It validates all inputs, performs an immediate PostgreSQL refresh, starts a ticker for subsequent refreshes, and stops on context cancellation. It is safe for each payment-engine replica to run its own refresher against the shared PostgreSQL queue. The function intentionally does not swallow an initial database failure; startup composition must fail or hold the readiness gate when the first authoritative refresh fails. Subsequent refresh errors are not converted into fabricated zeroes.

The remaining integration requirement is to invoke this function from the actual queue-worker composition with the application `*sql.DB`, a positive interval, and a cancellation context. The current payment-engine binary does not compose a Fabric queue worker or PostgreSQL queue instance, so live cross-replica invocation cannot be demonstrated in this sandbox.

## Required staging evidence

The authorized staging run must apply the exporter-enabled Deployment, verify `/metrics` through the ClusterIP Service, check Prometheus target health, import the queue dashboard, and confirm all replicas expose distinct `namespace`/`pod` labels. It must then run PostgreSQL contention with `pg_stat_activity`, `pg_locks`, pool wait metrics, queue claim duration, lease-loss rate, and exporter scrape health captured in the immutable evidence bundle.
