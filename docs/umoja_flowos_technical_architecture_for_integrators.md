# UmojaFlowOS Technical Architecture for Technology Partners and System Integrators

**Audience:** Solution architects, platform engineers, security architects, data engineers, managed-service providers, and integration partners.

**Architecture stance:** Open-source-first, PostgreSQL-first, cloud-agnostic, fail-closed, and evidence-oriented. The platform is designed to run on infrastructure operated by Newwave, an approved institution, a government programme, or a qualified system integrator. It does not require a proprietary cloud control plane.

## 1. Logical architecture

```text
Users and partner systems
        |
   Caddy / TLS edge
        |
 APISIX / OPA policy boundary
        |
 Keycloak identity and roles
        |
 Control Plane (TypeScript, Express/tRPC)
   |         |          |          |
PostgreSQL  Redis     Event bus   Evidence API
   |         |          |          |
Payment Engine  Risk & Compliance  Reporting/Lakehouse
   |         |          |          |
Ledger Gateway -> TigerBeetle     OpenSearch/WORM
        |
Observability: Prometheus / Grafana / Alertmanager / Wazuh / PagerDuty
```

The control plane is the authority surface for workflow state, role checks, approvals, and evidence state. PostgreSQL is the canonical control-plane data store. Redis is limited to short-lived idempotency, replay, and cacheable non-authoritative control data. TigerBeetle is the authoritative high-integrity financial ledger when deployed and approved; it is reconciled against the PostgreSQL projection. Object storage with Object Lock or an equivalent WORM implementation stores immutable evidence. OpenSearch provides operational search and retention-managed indexes but must not be treated as the sole source of financial truth.

## 2. Service responsibilities

| Component | Responsibility | Integration boundary | Required partner evidence |
|---|---|---|---|
| Caddy | Public TLS termination and edge exposure | HTTPS, certificates, strict headers | Certificate chain, TLS scan, renewal test |
| APISIX | API gateway, routing, authentication handoff, rate limits | OIDC/JWKS, upstream mTLS, policy routes | Route test, denied-path test, issuer/audience proof |
| OPA / policy engine | Declarative policy evaluation | Authenticated subject, action, resource, context | Policy bundle digest, allow/deny matrix |
| Keycloak | Identity, roles, client authentication, token lifecycle | OIDC, JWKS, admin APIs, realm configuration | Realm export, issuer/audience tests, revocation/rotation test |
| Control plane | Workflow authority, stakeholder UI/API, approval state, audit events | tRPC/HTTP, PostgreSQL, policy engine, event bus | Route contract, role test, SoD evidence |
| PostgreSQL | Canonical state, evidence metadata, reconciliation projection | TLS, least-privilege roles, migrations | Migration receipt, role grants, backup/restore test |
| Payment engine | Order validation, webhook verification, provider workflow coordination | HMAC, timestamp, replay, CIDR, provider API | Provider contract, signature test, retry/idempotency test |
| Ledger gateway | Balanced posting verification and reconciliation support | TigerBeetle client, PostgreSQL projection | Cluster ID, quorum, transfer, mismatch, failover evidence |
| TigerBeetle | Double-entry financial ledger | Private network, authenticated client, cluster configuration | Real staging cluster and consensus/failover evidence |
| Risk/compliance core | Screening cases, AML/CFT/CPF, Travel Rule, escalation | Approved screening provider, event bus, analyst workflow | Clear/hit/false-positive/timeout/unavailable cases |
| Reporting and analytics | Aggregates, regulatory packs, impact metrics | Governed extracts, lakehouse, OpenSearch | Data lineage, minimisation, report validation |
| Document intelligence | Review assistance and provenance | Consent-bound model endpoints | Model provenance, review-required controls |
| Evidence gateway | JWT verification, release binding, object publication | Keycloak, MinIO/S3-compatible WORM | Digest verification, path policy, object-lock proof |
| Retention worker | Fail-closed deletion authorisation | PostgreSQL claim, signed manifest, OpenSearch mTLS | Legal-hold negative test, signature mismatch, single-use test |
| Observability | Metrics, logs, alerts, incident signals | Prometheus, Grafana, Alertmanager, Wazuh | Live scrape, alert delivery, human acknowledgement |

## 3. Trust boundaries

### Identity boundary

Every request must carry an identity issued by the approved Keycloak realm or an approved partner identity federation. JWT verification must validate signature, issuer, audience, expiry, and required role claims. Administrative APIs require stronger role and approval checks than read-only APIs.

### Financial boundary

PostgreSQL stores workflow and projection state. TigerBeetle, when activated, stores authoritative ledger facts. The payment engine never infers settlement from an HTTP success alone. A mismatch or indeterminate ledger result is a stop condition.

### External-provider boundary

AML screening, sanctions data, Travel Rule messaging, payment providers, banks, identity verification, and notification services are external dependencies. Each must have an explicit contract, endpoint, credential reference, timeout, retry, failure classification, and evidence test. A simulator is suitable for unit or contract tests, not proof of production integration.

### Evidence boundary

Evidence is written through the evidence gateway into an approved WORM-compatible store. Manifest paths, release SHA, SHA-256 digests, object retention, legal hold, and detached signatures are verified before a release can pass E-09.

## 4. Data architecture

PostgreSQL migrations are forward-only and contain the canonical business and assurance schema. Integrators must not add an unversioned table, alter a regulated field, or change retention semantics outside a reviewed migration. Sensitive documents and raw identity bytes must remain outside ordinary relational records; PostgreSQL should retain only references, classifications, digests, and review outcomes.

The lakehouse and analytics layer receives only governed, minimised extracts. A typical flow is:

```text
Operational PostgreSQL / ledger facts / approved events
        -> schema validation and lineage
        -> privacy filtering and aggregation
        -> Bronze immutable manifest
        -> governed Silver analytical data
        -> reports, dashboards, and policy evidence
```

Entity resolution, if enabled, must use deterministic identifiers first, documented blocking rules second, and probabilistic matching only with confidence thresholds, human review, and a reproducible audit record.

## 5. Security controls

The minimum control set includes mTLS for sensitive service-to-service paths, Keycloak OIDC with short-lived tokens, secret-manager references rather than inline secrets, HMAC-SHA256 webhook verification with freshness and replay protection, CIDR enforcement where provider contracts support it, least-privilege PostgreSQL roles, OPA policy evaluation, four-role release approval, twelve distinct governance subjects for six primary/alternate roles, WORM retention, signed manifests, and tamper-detection alerts.

Integrators must demonstrate negative cases, not only successful cases. Required examples include invalid issuer, wrong audience, expired token, revoked token, duplicate webhook, stale timestamp, signature mismatch, unavailable screening provider, ledger timeout, reconciliation mismatch, legal hold, invalid release digest, duplicate approval subject, and failed rollback health gate.

## 6. Deployment model

A reference deployment uses Kubernetes or equivalent orchestration with separate namespaces for edge, control plane, data, evidence, observability, and test dependencies. PostgreSQL, Keycloak, Redis, eventing, OpenSearch, and WORM storage must not be exposed through public database or management ports. NetworkPolicy or an equivalent firewall model must restrict east-west traffic.

A system integrator must supply:

- Infrastructure-as-code for the target environment.
- Secret and certificate injection through an approved secret manager.
- PostgreSQL backup, restore, replication, and role-provisioning procedures.
- Keycloak realm/client configuration with issuer and redirect verification.
- Ledger cluster provisioning with cluster-ID and quorum validation.
- Monitoring dashboards, alert routes, and escalation ownership.
- Release rollback and disaster-recovery procedures.
- E-01 through E-09 evidence collection and immutable publication.

## 7. Integration contracts

| Contract | Minimum acceptance test |
|---|---|
| OIDC | Valid token succeeds; wrong issuer, audience, expiry, and role fail |
| Webhook | Valid HMAC succeeds; stale, replayed, malformed, and wrong-source requests fail |
| Screening | Clear, hit, false-positive, timeout, unavailable, and escalation paths are recorded |
| Travel Rule | Approved schema exchange or explicit test-scope exclusion with documented rationale |
| Ledger | Balanced transfer succeeds; duplicate, mismatch, missing fact, timeout, and consensus-loss states are safe |
| Evidence | Valid release SHA and digest publish; tampered digest and unsafe path fail |
| WORM | Retention, legal hold, detached signature, restore, and tamper negative tests pass |
| Monitoring | Critical alert reaches the configured receiver and receives human acknowledgement |
| Rollback | Failed health gate triggers rollback, restore, reconciliation, and evidence capture |

## 8. Performance and resilience

Capacity targets must be set from the approved sandbox test perimeter rather than guessed. Load tests should record throughput, p50/p95/p99 latency, error rate, queue depth, database lock waits, connection-pool saturation, ledger response time, and provider timeout behavior. Chaos tests should be limited to an approved environment and cover network partitions, identity dependency loss, screening timeouts, ledger consensus disruption, evidence-store unavailability, database exhaustion, and certificate rotation.

A service is not production-ready merely because its unit tests pass. Readiness requires a live, version-bound, independently reviewed staging run with real external contracts and complete evidence.

## 9. Observability and operations

Every material event should carry a correlation ID, release SHA, subject, action, resource, outcome, and timestamp. Prometheus measures service and control health; Grafana presents trends; Alertmanager routes urgency; Wazuh analyses security events; PagerDuty or an equivalent service manages human escalation. Logs must avoid secrets, raw identity documents, private keys, and unnecessary personal data.

## 10. Partner onboarding sequence

1. Confirm the target environment, responsible operator, and approved scope.
2. Review schemas, APIs, network boundaries, and data-classification rules.
3. Provision PostgreSQL, Keycloak, eventing, evidence, and observability dependencies.
4. Configure secrets, certificates, roles, policies, and migration permissions.
5. Execute contract and negative-path tests.
6. Run controlled integration, reconciliation, rollback, restore, and resilience tests.
7. Collect E-01 through E-09 artifacts on one immutable release.
8. Obtain independent E-09 review and four distinct production approvals.
9. Obtain the applicable regulatory and business approvals before activating live value movement.

## 11. Explicit non-claims

UmojaFlowOS is not itself a bank, VASP, exchange, custodian, IMTO, payment institution, regulator, or settlement network. Its technology can support an authorised operator’s governed workflows, but licensing, customer obligations, funds safeguarding, custody, settlement, reporting, and regulatory accountability remain with the authorised entities and competent authorities.
