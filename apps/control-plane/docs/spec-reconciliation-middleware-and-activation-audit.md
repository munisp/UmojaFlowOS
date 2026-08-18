# Specification Reconciliation, Middleware Assessment, and Activation Audit

## Reconciliation result

The original enterprise specification **does include** the requested architecture elements: APISIX and open-appsec at the edge; Keycloak identity; Dapr plus Kafka; Temporal; TigerBeetle plus PostgreSQL; Redis; Wazuh to OpenSearch; OpenCTI; Mojaloop; and a Delta/Parquet lakehouse with Flink, Spark, Sedona, Ray, and DataFusion. The user-requested **Fluvio**, **Permify**, and **GeoLibre** are not named in that specification; they are valid optional additions but must be recorded as architecture extensions rather than implemented-spec requirements.

The current ledger is only **partially synchronized** with that specification. It tracks PostgreSQL, Go/Rust/Python services, ledger controls, payments, reporting, KYC/KYB, RBAC, and provider gates. It does **not** yet track concrete implementation boundaries for APISIX, open-appsec, Keycloak, Dapr, Kafka/Fluvio, Temporal, TigerBeetle, Redis, Mojaloop, OpenSearch/Wazuh, OpenCTI, Sedona, GeoLibre, or the lakehouse. Lines 94–96 of `todo.md` now preserve that gap explicitly; no component is being represented as implemented.

| Component | Specification status | Recommended owner | Current status | Hard prerequisite |
|---|---|---|---|---|
| PostgreSQL | Day-1 | TypeScript control plane | Local canonical schema and partial read/write port are implemented | Approved data reconciliation and production database for cutover |
| APISIX + open-appsec | Day-1 / scale-up enforcement | TypeScript gateway and platform configuration | Not implemented | Deployment target, TLS, secret-managed admin credentials, ingress policy |
| Keycloak | Day-1 | TypeScript identity adapter | Not implemented; current managed OAuth is not Keycloak | Realm, clients, roles/claims, TLS, bootstrap administration |
| Dapr + Kafka | Day-1 | Go event/orchestration boundary | Not implemented | Self-hosted/Kubernetes runtime, topics/ACLs, secrets, observability |
| Fluvio | Extension / scale-up | Rust streaming gateway | Not in source specification and not implemented | Cluster, durable storage, TLS, topic topology |
| Temporal | Day-1 | Go payment-engine workflows | Contracts only; no Temporal worker/server integration | Temporal deployment, namespace, PostgreSQL persistence, TLS/auth |
| TigerBeetle | Day-1 | Rust ledger gateway | Balanced-posting validation exists; TigerBeetle client/cluster projection is not implemented | Persistent cluster, approved topology, key management, authorised ledger data |
| Redis | Scale-up | TypeScript cache adapter | Not implemented | Approved non-authoritative cache use case and secured runtime |
| Permify | Extension / scale-up | Go authorization boundary | Not in source specification and not implemented | Self-hosted/managed decision, relationship data, authorization store |
| Mojaloop | Scale-up | Go adapter | Not implemented | Scheme participation, licensed partners, sandbox/production credentials, callbacks |
| OpenSearch + Wazuh | Day-1 security logging / scale-up SIEM | Go projection/observability boundary | Not implemented | Secured cluster, index/retention policy, approved non-monetary data feeds |
| Apache Sedona | Advanced lakehouse analytics | Python reporting analytics | Not implemented | Spark/Sedona runtime and approved geospatial data |
| GeoLibre | Extension / advanced | TypeScript visualization workspace | Not in source specification and not implemented | Approved geospatial sources and separate static/desktop deployment |
| Lakehouse | Day-1 Bronze/Silver, scale-up Gold | Python ingestion/analytics | Not implemented | Governed object storage, Delta/Parquet format, lineage/retention, compute/query engine |

## Exact `input_unavailable` fail-closed logic

The implemented proposal helper does not fabricate a stress-test amount. It loads the approved buffer policy and rejects execution when the policy is absent or inactive. It rejects reconciliation timestamps more than 24 hours old, rejects expiry timestamps that are not in the future, converts the available balance, verified funding gap, daily exposure, policy minimum, target, and cap to numbers, then fails closed if **any** is non-finite or if balance/gap is negative:

```ts
if (!p) throw new Error("Treasury buffer policy is unavailable or inactive");
if (Date.now() - input.reconciledAt.getTime() > 24 * 60 * 60 * 1000) {
  throw new Error("Reconciled balance is stale; recommendation generation fails closed");
}
if (input.expiresAt <= new Date()) throw new Error("Recommendation expiry must be in the future");
if (![available, gap, daily, minimum, target, cap].every(Number.isFinite) || available < 0 || gap < 0) {
  throw new Error("Invalid reconciled evidence; recommendation generation fails closed");
}
```

Only after all guards pass does it calculate `max(0, min(target - available, target * cap_pct, verified_funding_gap))`, persist evidence and a `proposed` recommendation, and append an activity event whose metadata explicitly says `executionInitiated: false`. A separate administrator can decide, but cannot be the proposer and cannot decide an expired proposal. The SQL stress-test table represents a missing input as `input_unavailable`, with an evidence/limitation record and **no numeric result columns**.

## Unchecked ledger items requiring external authorization or real reconciled data

| Ledger lines | Requirement | Why it cannot truthfully be completed now |
|---|---|---|
| 10–11, 16, 22–23 | Liquidity, rate/FX, rate locks, provider adapters, payment rails, and deadlines | Needs reconciled balances/exposure, authorised pricing/rail data, licensed counterparties, and provider credentials; payments cannot execute without them. |
| 20, 32–33, 52–55, 59–62, 68–70, 74, 76–77 | End-to-end KYC/KYB, SAR/STR, evidence, document ingestion, and visual/PAD validation | Needs active consent, authorised documents, secure S3/object storage, private endpoint credentials, and real review evidence. No customer or document data may be fabricated. |
| 23, 36–39, 82, 90 | Scheduled reminders, source-to-target migration/reconciliation, and full regulatory lifecycle | Needs a deployed site before Heartbeat creation; approved non-empty source snapshot; real legal entity/report evidence; verified submission channel reference. |
| 29–31, 47–48, 83 | Counterparty licence, risk, and lifecycle validation | Needs real counterparty/licence evidence; no counterparty or authorization record can be fabricated for testing. |
| 54, 61–65 | Production private Ollama and secure ingestion | Needs approved production endpoint/TLS/mTLS/secrets and authorised evaluation material. |
| 95–96 | Middleware/lakehouse components | Requires the self-hosted deployment decision and infrastructure listed above; Mojaloop additionally requires authorised scheme/participant relationships. |

All other unchecked items are either remaining provider-independent implementation/testing work or cutover/deployment work; they must not be marked complete until the corresponding code and validation evidence exist.

## Complete policy DDL and RBAC matrix

The complete canonical DDL is attached separately as `0004_treasury_rebalancing_controls.sql`; it defines all policy, recommendation, and stress-run columns, foreign keys, checks, and indexes. The current local PostgreSQL catalog contains all three policy tables and **26** associated table constraints.

| Procedure | Route role middleware | Effective roles | Write/action boundary |
|---|---|---|---|
| `treasury.proposePostgresRebalancing` | `treasuryProcedure` | `admin`, `treasury_operator` | May create an evidence-backed recommendation only; no transfer. |
| `treasury.decidePostgresRebalancing` | `adminProcedure` | `admin` | May independently approve/reject; requires reason; proposer and expired proposal are rejected. |
| Policy/recommendation evidence reads | `auditorProcedure` where exposed | `admin`, `compliance_officer`, `treasury_operator`, `auditor` | Read-only inspection. |
| Compliance policy-document review | `complianceProcedure` | `admin`, `compliance_officer` | Documentation/compliance boundary; it cannot approve treasury recommendation. |

The role middleware itself is deny-by-default: an absent user receives `UNAUTHORIZED`; a user outside the procedure role list receives `FORBIDDEN`.
