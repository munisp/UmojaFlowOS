# Staging deployment, audit aggregation, and TigerBeetle load test

## GitHub Actions staging deployment

The protected workflow is `.github/workflows/staging-deploy.yml`. It is manual and uses GitHub Environment approvals rather than deploying on every pull request. The required sequence is:

```text
pull-request CI → staging-gates approval → immutable image digest → staging deployment → post-deploy rollout gate
```

The workflow refuses mutable image tags. Invoke it with a SHA-256 image digest and explicit activation booleans:

```bash
gh workflow run staging-deploy.yml \
  -f image_tag=sha256:<immutable-image-digest> \
  -f enable_keycloak=true \
  -f enable_tigerbeetle=true
```

Configure GitHub Environments as follows:

```text
staging-gates: required reviewers, no production secrets
staging: required reviewers, protected kubeconfig/workload identity, staging-only secrets
```

The Keycloak and TigerBeetle tests remain opt-in. Live staging tests must receive their short-lived credentials and endpoints from the protected environment, never from pull-request inputs.

## Audit aggregation

`infra/logging/vector-umoja-security.toml` collects two structured sources:

```text
/var/log/keycloak/events/*.json
/var/log/umoja/ledger/*.jsonl
```

It normalizes them into the `umoja.security.audit.v1` envelope, removes credentials/tokens/secrets, writes a local Wazuh JSONL stream, and sends compressed bulk events to the private OpenSearch endpoint using disk buffering. OpenSearch credentials are environment-injected and must be supplied by an external secret manager.

Required audit fields are:

```text
audit_schema
event_source
event_category
timestamp
result
```

Keycloak events should contain subject, client ID, event type/result, and timestamp. Ledger events should contain transfer ID, correlation ID, currency, amount in minor units, debit/credit account IDs, result, and timestamp. Do not emit payment credentials, refresh tokens, authorization headers, or private keys.

The aggregation agent must run with a read-only mount for source logs where possible, a protected disk buffer, TLS verification for OpenSearch, and a WORM export of the final daily audit batch. Wazuh FIM and the independent Object Lock verifier remain the authoritative integrity controls.

## Peak-throughput load test

The Go command is:

```text
services/payment-engine/cmd/tigerbeetle-loadtest
```

It is deliberately disabled unless both guards are present:

```text
TIGERBEETLE_LOADTEST_APPROVED=STAGING_ONLY_APPROVED
TIGERBEETLE_LOADTEST_TARGET=staging
```

Example invocation:

```bash
cd services/payment-engine

export TIGERBEETLE_LOADTEST_APPROVED=STAGING_ONLY_APPROVED
export TIGERBEETLE_LOADTEST_TARGET=staging
export TIGERBEETLE_LOADTEST_ADDRESS='tb-replica-proxy.staging.internal:3000'
export TIGERBEETLE_LOADTEST_CLUSTER_ID='<staging-cluster-id>'
export TIGERBEETLE_LOADTEST_NGN_LEDGER='<staging-ngn-ledger-id>'
export TIGERBEETLE_LOADTEST_ACCOUNT_CODE='<staging-account-code>'
export TIGERBEETLE_LOADTEST_TRANSFER_CODE='<staging-transfer-code>'
export TIGERBEETLE_LOADTEST_DEBIT_ACCOUNT_ID='<dedicated-loadtest-debit-account>'
export TIGERBEETLE_LOADTEST_CREDIT_ACCOUNT_ID='<dedicated-loadtest-credit-account>'
export TIGERBEETLE_LOADTEST_TLS_REQUIRED=true
export TIGERBEETLE_LOADTEST_ALLOW_INSECURE_LOOPBACK=false
export TIGERBEETLE_LOADTEST_BATCH_SIZE=256
export TIGERBEETLE_LOADTEST_WORKERS=4
export TIGERBEETLE_LOADTEST_DURATION_SECONDS=60

go run ./cmd/tigerbeetle-loadtest
```

The command uses the official adapter, sends batch transfers concurrently, records batch count, transfer count, failures, elapsed time, throughput, and p50/p95/p99 call latency, and emits one JSON report. It limits the duration to 300 seconds, the batch size to 8,192, and workers to 64. Any failure or zero successful transfers exits nonzero.

Use dedicated staging accounts funded only for the test. Freeze or isolate customer-facing traffic, establish a maximum approved transfer amount, monitor CPU/network/replica lag, and reconcile every generated transfer ID afterward. Do not run this command against production or shared customer accounts.

## Current validation

The load-test command compiles and the existing ledger package tests pass:

```text
go test ./cmd/tigerbeetle-loadtest: passed
go test ./internal/ledger: passed
git diff --check: passed
```

No live cluster was contacted. A successful load-test JSON report is performance evidence for the tested staging topology only; it is not a guarantee of production throughput or regulatory readiness.
