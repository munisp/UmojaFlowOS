# Fabric Live Benchmark and PostgreSQL Queue Contention Assessment

## Live benchmark status

A live multi-peer Fabric benchmark could not be executed in the current sandbox. No `kubectl`, `istioctl`, `grpcurl`, Fabric `peer`, or `orderer` client is installed; no kubeconfig/context is present; no Fabric endpoint or identity variables are configured. The live gate therefore remains blocked rather than being represented as a pass.

The committed local simulation used 100 concurrent identical submissions with a 5 ms synthetic commit delay. It observed one success and 99 MVCC-style conflicts. This validates the expected duplicate-safety shape only. It does not measure real peer endorsement throughput, orderer commit latency, event-delivery latency, or Fabric conflict rates.

## PostgreSQL queue transaction behavior

The Fabric queue uses `database/sql` and calls `BeginTx(ctx, nil)`. Because no explicit isolation level is supplied, PostgreSQL uses the database/session default, normally `READ COMMITTED`. This is appropriate for the short claim transaction because the row is protected by `FOR UPDATE SKIP LOCKED`, and the selected row is immediately updated with a lease token before commit.

The claim transaction does not hold a database lock while contacting Fabric. `MarkUnknown` and `MarkComplete` use single conditional updates that require the queue ID, attempt number, and lease token. A stale or competing worker updates zero rows and receives `ErrQueueLeaseLost`.

The queue does not configure the `sql.DB` pool. No `SetMaxOpenConns`, `SetMaxIdleConns`, or connection lifetime settings were found in the payment-engine module. Pool sizing is therefore an application-composition responsibility and is not currently proven by the queue package. A deployment must set pool limits explicitly and reserve connections for API traffic, migrations, reconciliation, and health checks.

## Contention behavior

`SKIP LOCKED` avoids head-of-line blocking between workers, but it does not eliminate contention. Under heavy polling, workers can compete on the due-item index, update the same hot rows if lease expiry is aggressive, and exhaust the database pool while waiting for connections. The queue should use a bounded worker count, a poll interval/backoff when no rows are available, and a lease duration longer than the normal claim-to-Gateway handoff.

The queue’s process-local admission semaphore controls Fabric Gateway calls but does not by itself control PostgreSQL pool consumption. The admission limit and total worker count must be sized together with the configured `MaxOpenConns`. A conservative starting rule is to reserve connections for non-queue traffic and keep queue workers below the remaining pool capacity; this requires staging measurement rather than a universal numeric default.

## Required staging measurements

The authorized staging benchmark must record PostgreSQL pool wait duration, in-use/idle connections, transaction duration, lock wait events, claim rate, lease-loss count, queue depth, UNKNOWN age, Fabric endorsement latency, orderer commit latency, and MVCC conflict outcomes at 1, 4, 16, 32, 64, and 100 concurrent workers. It must repeat the run during a controlled partition and after recovery.

A production pass requires that queue claims remain short, no lease loss occurs under the approved workload, pool exhaustion does not affect settlement-critical traffic, and every Fabric timeout is reconciled without a blind duplicate submission.
