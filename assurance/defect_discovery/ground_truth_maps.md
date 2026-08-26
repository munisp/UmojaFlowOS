# Ground-Truth Maps — UmojaFlowOS Defect Discovery

**Audit baseline:** `71b14909ec2cc9e373158120aab2c03953bb89fa` (`origin/main` at review start)
**Method:** tracked executable source, runtime entry points, SQL migrations, Docker/Compose/Kubernetes manifests, and route registration were treated as ground truth. README/UI claims and local dry-run evidence were not used to establish capability.

> **Scope boundary.** This map describes the repository state. It does not prove the availability, identity, authorization, or behavior of any external staging/production system. Every external dependency remains fail-closed until independently evidenced.

## Map coverage

| Mandatory map | Covered source surface | Coverage | Basis |
|---|---|---:|---|
| Service map | All tracked Go/Python entry points, the control-plane process entry point, retention deployment manifests, and security-stack Compose services | 100% | Entry points and manifests were enumerated from the tracked tree and reconciled against bind/listener code. |
| Money map | `payment_orders` / `payment_legs` schema, TigerBeetle posting path, provider webhook/reconciliation path, and simulator-only ledger state | 100% of identified value-moving paths | SQL and Go/Python mutation paths were inspected. |
| Trust-boundary map | Internal HTTP clients, external provider/webhook code, OIDC routes, PostgreSQL, OpenSearch, WORM, alerting, and scheduler routes | 100% of tracked executable boundary declarations | Source calls/routes and deployment URL variables were enumerated. |
| Gate map | Express/tRPC registration, scheduled routes, provider runtime gates, worker bearer/HMAC/mTLS checks, database role initialization, and declared governance roles | 100% of declared executable gate implementations discovered | Route registration and guard construction were inspected; UI-only declarations are intentionally excluded from enforcement claims. |
| Config map | `os.Getenv`, `os.environ`, `process.env`, Compose, Helm/Kubernetes, and secret-file bindings in tracked executable/deployment files | 100% of defaults and placeholders identified in the reviewed runtime paths | Defaults are recorded as runtime behavior, not safe configuration. |

## 1. Service map

| Service/process | Real bind or declared deployment port | Executable route/operation surface | Source evidence |
|---|---:|---|---|
| Control plane (Express + tRPC) | Prefers `PORT` or `3000`; it may select `3001`–`3019` if the preferred port is unavailable | Raw `/internal/ledger/projections`; scheduled POST routes; `/api/trpc`; OIDC and storage-proxy routes | `apps/control-plane/server/_core/index.ts:44-60`, `:70-83` |
| Payment engine (Go) | `PORT` or `8081` | `GET /healthz`; `GET /v1/metrics`; conditional `POST /v1/providers/yellowcard/webhooks`, `/v1/providers/yellowcard/sends`, `/v1/ledger/postings`; `POST /v1/orders/validate` | `services/payment-engine/cmd/payment-engine/main.go:117-148`, `:190-247`, `:292-298` |
| Retention delete worker (FastAPI) | `0.0.0.0:8080` | `GET /healthz`; `GET /metrics`; authenticated `POST /v1/worker/delete` | `simulators/retention_gateway/worker_service.py:141-196`, `:240-244`; `infra/retention-gateway/kubernetes.yaml:56` |
| Synthetic retention circuit monitor | `SYNTHETIC_PROMETHEUS_PORT` or `9468` | Prometheus exporter only; probes configured worker/metrics URLs | `simulators/retention_gateway/synthetic_circuit_monitor.py:148-161`; `infra/retention-gateway/synthetic-monitor/kubernetes.yaml:47` |
| Production-dependency simulator | FastAPI app; port is supplied by its service command/deployment rather than this module | Health, OIDC discovery/JWKS, edge authorization, AML screen, simulated ledger, webhook, WORM attestation, lakehouse, entity-resolution endpoints | `simulators/production_dependencies/app.py:15`, `:58-158`, `:200-297` |
| Incident-response evidence service | FastAPI app; deployment binding must be confirmed from its deployment command before it can be considered reachable | Incident evidence capture endpoint set constructed by `create_app` | `simulators/retention_gateway/incident_response_service.py:113-171` |
| PostgreSQL | Deployment dependency, not repository listener | Authoritative control-plane schema, retention authorization/manifests, reconciliation state, governance/audit tables | `database/postgresql/0001_control_plane.sql:134-160`; `infra/retention-gateway/postgres-init.sql` |
| TigerBeetle | External cluster client; not an HTTP listener in this repository | Transfer posting through configured official client; staging load test is separately guard-railed | `services/payment-engine/cmd/payment-engine/main.go:250-274`; `services/payment-engine/cmd/tigerbeetle-loadtest/main.go:43-60` |
| OpenSearch | External HTTPS endpoint | Retention index identity lookup and exact physical-index deletion through mTLS client | `simulators/retention_gateway/worker_service.py:90-138` |

**Service-map caution.** The control plane’s dynamic fallback from `3000` to `3001`–`3019` is real behavior, while Compose declares a `3000` upstream. It is retained as a Phase-1 F16 cross-check rather than assumed to be safe merely because the normal container path uses an available `3000` port.

## 2. Money map

| Value-bearing entity or operation | Authoritative representation | Mutations/status path | Safety-relevant ground truth |
|---|---|---|---|
| `payment_orders` | PostgreSQL order row with unique `idempotency_key`; source/target `NUMERIC(30,12)` positive amounts and constrained currencies | Created/updated by control-plane workflow paths; value legs are modeled separately | `database/postgresql/0001_control_plane.sql:134-151` |
| `payment_legs` | PostgreSQL rows per order/sequence; kinds include collection, FX, stablecoin settlement, payout, reversal | Provider references and leg status are persisted; executable provider settlement still requires independent evidence | `database/postgresql/0001_control_plane.sql:152-160` |
| TigerBeetle confirmed transfer | Unsigned integer minor units plus debit/credit account IDs and transfer ID | `POST /v1/ledger/postings` validates nonzero numeric identifiers and delegates to `PostingService.PostConfirmedTransfer` | `services/payment-engine/cmd/payment-engine/main.go:91-109`, `:148-188` |
| Payment-order validation | Domain `Money` values and nonterminal validation event | `POST /v1/orders/validate` emits an order-validated envelope and explicitly reports provider execution disabled | `services/payment-engine/cmd/payment-engine/main.go:190-246` |
| Yellow Card provider execution | Outbound provider instruction plus verified approval material | Route is not registered unless the runtime is enabled from validated environment configuration | `services/payment-engine/cmd/payment-engine/main.go:275-287`, `:141-146` |
| Yellow Card webhook/reconciliation | Webhook evidence and independent provider/ledger reconciliation state | A webhook’s `completed` provider status is not itself a settlement authority; repository code records pending reconciliation | `services/payment-engine/internal/provider/yellowcard_webhook.go:391-473`; `services/payment-engine/internal/provider/yellowcard_reconciliation.go:61-69` |
| Retention authorization/manifest | PostgreSQL authorization use records and HMAC-signed manifests, not customer monetary value | Atomic authorization claim precedes exact index deletion | `infra/retention-gateway/postgres-init.sql`; `simulators/retention_gateway/worker_service.py:167-176`, `:196-235` |
| Dependency-simulator ledger | In-memory Python dictionary only | `POST /v1/ledger/transfers` returns simulated `posted` state and is not durable/external | `simulators/production_dependencies/app.py:17`, `:104-122` |

**Money-map assertion.** Simulator ledger state is **not** a money-of-record. Any UI/API claim that represents it as a real settlement would be a defect; this is explicitly targeted in F1/F15 discovery.

## 3. Trust-boundary map

| Boundary | Direction and trust material | Real enforcement path | Source evidence |
|---|---|---|---|
| Browser/client to control plane | Express parsing, tRPC context, OIDC route registration | Raw body only for ledger projection; general JSON and tRPC registered afterward | `apps/control-plane/server/_core/index.ts:41-61` |
| Payment engine to control plane ledger projection | Outbound HTTPS endpoint and HMAC secret resolved from approved material root | Engine only initializes posting when TigerBeetle runtime is configured/reachable; secret resolver errors panic | `services/payment-engine/cmd/payment-engine/main.go:250-274` |
| Provider to payment engine webhook | Public webhook ingress | Conditional route, timestamp/signature/replay validation in provider webhook implementation | `services/payment-engine/cmd/payment-engine/main.go:141-146`; `services/payment-engine/internal/provider/yellowcard_webhook.go` |
| Payment engine to Yellow Card execution API | Outbound external provider call | Handler is absent unless runtime enables execution; approval HMAC secret must resolve | `services/payment-engine/cmd/payment-engine/main.go:275-287` |
| Retention gateway to PostgreSQL | Database URL and worker-scoped pool | Bounded pool, statement/lock/idle-transaction timeouts, PostgreSQL authorization use store | `simulators/retention_gateway/worker_service.py:143-176` |
| Retention gateway to OpenSearch | HTTPS plus CA, client certificate, and client key | Rejects non-HTTPS/missing mTLS files; maps TLS/auth and authorization failure to explicit errors | `simulators/retention_gateway/worker_service.py:90-114` |
| Synthetic monitor to worker | Configured in-cluster metrics/worker URL | Deployment declares retention worker metrics endpoint; monitor emits its own metrics | `infra/retention-gateway/synthetic-monitor/kubernetes.yaml:38-47` |
| Wazuh/PagerDuty/WORM/lakehouse endpoints | Simulator and production adapter boundaries | Simulator labels its health mode as simulated; production assertions require external staged receipts | `simulators/production_dependencies/app.py:58-60`, `:230-259` |
| Scheduler caller to control plane | Four privileged POST scheduler endpoints | Routes are registered directly; scheduler authentication must be checked per handler in F3/F8 sweep | `apps/control-plane/server/_core/index.ts:51-54` |

## 4. Gate map

| Declared/implemented gate | Where it is evaluated | Fail-closed behavior to verify in discovery |
|---|---|---|
| TigerBeetle runtime activation | Payment-engine startup | Runtime setup failure panics; ledger posting route is not registered without configured/reachable TigerBeetle | `services/payment-engine/cmd/payment-engine/main.go:250-274`, `:147-189` |
| Yellow Card execution activation and HMAC approval material | Payment-engine startup and conditional route registration | Secret resolution failure panics; send route is absent while disabled | `services/payment-engine/cmd/payment-engine/main.go:275-287`, `:141-146` |
| Retention worker bearer token | Delete route | Exact bearer-token mismatch returns `401` before deletion logic | `simulators/retention_gateway/worker_service.py:196-203` |
| Retention authorization token + signed manifest | Delete worker | Worker verifies token and manifest prior to exact deletion; full bypass analysis belongs to F3/F5/F10 | `simulators/retention_gateway/worker_service.py:167-176`, `:216-235` |
| Retention mTLS | OpenSearch client construction and requests | Missing files/non-HTTPS fail startup; TLS/auth failure converts to deny/error path | `simulators/retention_gateway/worker_service.py:90-114` |
| DB saturation circuit breaker | Delete route | Open circuit returns `503`; repeated pool saturation opens circuit | `simulators/retention_gateway/worker_service.py:36-76`, `:211-234` |
| tRPC context/role procedures | tRPC router and context construction | All privileged procedures need route-by-route verification; a declaration is not treated as enforcement | `apps/control-plane/server/_core/index.ts:55-61`; `apps/control-plane/server/routers.ts` |
| Scheduled handler authentication | Handler implementations | Routes are exposed in Express; their handlers must reject absent/invalid scheduler authority | `apps/control-plane/server/_core/index.ts:51-54`; `apps/control-plane/server/scheduled/schedulerAuth.ts` |
| Database role segregation | Bootstrap SQL and migration grants | Gateway/worker and schema-owner roles must remain distinct in actual deployment; local code cannot prove staged grants | `infra/retention-gateway/postgres-init.sql`; `database/postgresql/grants.sql` |

## 5. Config map

| Configuration/default | Executable effect | Classification |
|---|---|---|
| `PORT || "3000"` for control plane | Binds preferred 3000, otherwise searches 3001–3019 | Safe only where service discovery tolerates fallback; F16 cross-check required | `apps/control-plane/server/_core/index.ts:29-35`, `:70-78` |
| `PORT || "8081"` for payment engine | Binds payment engine | Normal default, but deployment must bind the same port | `services/payment-engine/cmd/payment-engine/main.go:292-298` |
| Disabled provider/ledger status strings | Metrics and health explicitly say provider execution/ledger are disabled when unavailable | Honest capability status, not production readiness | `services/payment-engine/cmd/payment-engine/main.go:112-121`, `:126-139` |
| `RETENTION_*` pool/time-out defaults | PostgreSQL pool defaults: statement 5000 ms, lock 1500 ms, idle transaction 10000 ms, min 2/max 10, acquire 2 s | Must be bounds-checked and operationally validated | `simulators/retention_gateway/worker_service.py:148-165`, `:177-180` |
| OpenSearch URL/certificate variables | Requires `https://`, CA, client certificate/key files | Fail-closed startup configuration | `simulators/retention_gateway/worker_service.py:90-100`, `:169-173` |
| `SIMULATOR_WEBHOOK_SECRET || "ci-simulator-secret"` | Simulator accepts signatures generated with a repository-known fallback if env is absent | **Candidate F10 defect**: fallback must not be usable in a production-like deployment | `simulators/production_dependencies/app.py:20-21` |
| `SIMULATOR_REPLAY_WINDOW_SECONDS || "300"` | Bounds simulator webhook freshness | Simulator contract setting; production boundary must supply a separately governed setting | `simulators/production_dependencies/app.py:20-21` |
| Compose `UMOJA_*` upstreams and public URLs | Connects APISIX/control plane/payment engine to deployment targets | Must be cross-checked against actual service/route maps in F2/F16 | `infra/security-stack/compose.yaml:17-18`, `:53-55`, `:92-109`, `:126-146` |
| Manifest/authorization secret files | Worker reads bytes from required file paths; no literal fallback | Fail-closed provided process environment is complete | `simulators/retention_gateway/worker_service.py:143-146` |

## Phase-0 output and constraints

The five maps establish discovery scope, but no live capability is inferred from them. Specifically, the repository contains simulator routes and guarded real-component adapters; neither may be described as a staging/production completion without externally generated E-01–E-09 evidence. The next phase inventories F1–F16 against these maps before any fix is made.
