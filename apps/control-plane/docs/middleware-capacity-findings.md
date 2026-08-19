# Middleware capacity findings — measured 2026-08-19

Host: 3941 MB total RAM, no Docker available.

## Running live in this sandbox (verified, not assumed)

| Component | Version | Endpoint | Resident | Verification |
|---|---|---|---|---|
| Temporal | CLI 1.8.2, server 1.31.2 | `127.0.0.1:7233` | ~154 MB | `temporal operator cluster health` → `SERVING` |
| Permify | 1.7.3 | `127.0.0.1:3476` (HTTP), `:3478` (gRPC) | ~40 MB | `GET /healthz` → `{"status":"SERVING"}` |
| Redis | 7.0.15 | `127.0.0.1:6379` | ~10 MB | `redis-cli ping` → `PONG` |
| TigerBeetle | 0.17.9 | `127.0.0.1:3033` | ~1463 MB | replica opened, listening |
| PostgreSQL | 16 | unix socket | — | already canonical |

Start commands actually used:

```
temporal server start-dev --headless --port 7233 --db-filename /home/ubuntu/temporal-dev.db
permify serve --database-engine=memory --http-enabled=true --http-port=3476 --grpc-port=3478
sudo systemctl start redis-server
tigerbeetle format --cluster=0 --replica=0 --replica-count=1 --development /home/ubuntu/tb.db
tigerbeetle start --addresses=127.0.0.1:3033 --development /home/ubuntu/tb.db
```

Note: port 3000 is the dev server, so TigerBeetle uses 3033. TigerBeetle
preallocates ~1.06 GiB (1 GiB journal + grid) by design; after it starts, about
490 MB of headroom remains.

## Cannot run here, with the measured reason

| Component | Blocker |
|---|---|
| Kafka / Redpanda | JVM or ~1 GB native; no headroom after TigerBeetle |
| OpenSearch | JVM, 1 GB heap minimum |
| Keycloak | JVM, ~600 MB |
| Mojaloop | multi-service Kubernetes deployment |
| APISIX | requires etcd + OpenResty |
| open-appsec | requires APISIX |
| Dapr | sidecar runtime; only useful with a broker present |
| Fluvio | single-node cluster ~500 MB, competes with TigerBeetle |
| Apache Sedona | Spark, JVM, multi-GB |

GeoLibre and the lakehouse readers are in-process libraries rather than
servers, so they need no runtime allocation.

## Integration tiers chosen

- **Tier A — live integration with live regressions:** Temporal, Permify,
  Redis, TigerBeetle, PostgreSQL.
- **Tier B — real client code plus protocol-level contract tests, activation
  gated:** Kafka/Dapr/Fluvio, OpenSearch, Keycloak, APISIX/open-appsec,
  Mojaloop.
- **Tier C — in-process libraries:** GeoLibre, Sedona/lakehouse readers.
