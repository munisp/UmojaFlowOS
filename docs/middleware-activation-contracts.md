# Middleware Activation Contracts

## Purpose

Every self-hosted middleware component in this platform is deliberately shipped disabled. This document records the contract that makes that state verifiable rather than merely asserted, so a component cannot become live through an unnoticed configuration edit and no credential can be committed to the repository.

## The contract

Each component under `infra/` carries an environment template that is safe to commit and safe to deploy unchanged. Four rules apply to every template, and they are enforced mechanically by `scripts/infra/validate_activation_contracts.py`, which runs as part of `make check`:

> Every template declares an explicit `*_ENABLED` flag, and it must be false.
> Credentials appear only as indirections named `*_SECRET_REF` or `*_REFERENCE`, never as inline values.
> Every secret reference is either empty or holds the `REPLACE_WITH` placeholder.
> Any transport-security, certificate-verification, or fail-closed control present must be true.

The validator was exercised against a negative control: flipping a single `*_ENABLED` flag to true caused it to fail with a specific, actionable message, and restoring the flag returned it to a passing state. It therefore detects real drift rather than passing vacuously.

## Component coverage

| Component | Owning service | Template | Activation prerequisites beyond configuration |
| --- | --- | --- | --- |
| Temporal | Go payment engine | `infra/temporal/temporal.env.template` | Private namespace, mTLS certificate authority and client pair, worker deployment; provider activities remain separately gated |
| TigerBeetle | Go payment engine and Rust ledger gateway | `infra/tigerbeetle/tigerbeetle.env.template` | Private cluster identity, replica addresses, and a reconciled PostgreSQL projection before any transfer counts as settled evidence |
| Permify | TypeScript authorisation boundary | `infra/permify/permify.env.template` | Private deployment with the checked-in schema published; unreachable service is treated as deny |
| APISIX and open-appsec | Edge gateway | `infra/apisix/apisix.env.template` | TLS-protected Keycloak discovery endpoint, bearer-only routes, and open-appsec in prevent mode |
| Redis | Go idempotency boundary | `infra/redis/redis.env.template` | Private TLS-only deployment; an unreachable store rejects the request rather than replaying it |
| Mojaloop | Go payment engine | `infra/mojaloop/mojaloop.env.template` | Scheme authorisation reference, participant identity, and JWS signing material — a legal prerequisite, not a toggle |
| Fluvio | Rust and Go event boundary | `infra/fluvio/fluvio.env.template` | Private cluster with client certificates |
| OpenSearch | Python reporting analytics | `infra/opensearch/opensearch.env.template` | Private endpoint with mTLS or credentials; redacted audit projections only |
| Apache Sedona | Python reporting analytics | `infra/sedona/sedona.env.template` | Governed geospatial data with access control and privacy review |
| GeoLibre | Python reporting analytics | `infra/geolibre/geolibre.env.template` | Approved aggregate feed with cohort thresholds |
| Governed lakehouse | Python reporting analytics | `infra/lakehouse/lakehouse.env.template` | Retention policy, encryption key reference, and data-governance approval |
| open-appsec agent | Edge gateway | `infra/openappsec/openappsec.env.template` | Agent token and policy bundle references |

Kafka and Dapr are configured declaratively through `infra/dapr/components` and `infra/dapr/subscriptions` rather than an environment template, and Keycloak through its realm definition; both are covered by their own service-level validation and by the Rust fail-closed `INPUT_UNAVAILABLE_EVENT_STREAM` policy path.

## Why the flags are false

Enabling any of these components requires something this repository cannot legitimately contain: a private endpoint, a certificate, a scheme authorisation, or a data-governance approval. Setting a flag to true without those prerequisites would either fail at runtime or, worse, appear to succeed while operating without the control it implies. Keeping the flags false and validating them in continuous integration makes the platform's real posture visible instead of aspirational.
