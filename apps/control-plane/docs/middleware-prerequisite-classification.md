# Middleware Prerequisite Classification

## Purpose

This inventory classifies UmojaFlowOS middleware boundaries by implementation state and activation prerequisite. It is a deployment-control record, not authorisation to enable any component.

| Component | Ownership | Current state | Activation prerequisite | Fail-closed boundary |
|---|---|---|---|---|
| PostgreSQL | TypeScript | Canonical schema, typed procedures, local integration tests | Managed production database, backup/restore evidence, restricted access | Control-plane and projection storage only; not TigerBeetle monetary truth. |
| Kafka/Dapr and Fluvio | Go and Rust | Versioned contracts; disabled alternative stream templates | Private cluster, mTLS, topic ACLs, ordering controls | Missing event-stream input produces a fail-closed policy outcome. |
| Temporal | Go | Deterministic workflow configuration validation | Private namespace, task queue, TLS, worker deployment | Workflow configuration does not authorise payment activity. |
| Keycloak, Permify, APISIX | TypeScript and edge | Realm, deny-by-default policy, OIDC route templates | TLS issuer, secret-managed client credentials, policy publication | Blank discovery, missing policy, or anonymous fallback is denied. |
| Redis | Go | TLS-only idempotency boundary | Private deployment, mTLS, secret-managed password | Unconfigured or unavailable store denies operations. |
| Mojaloop | Go | Disabled typed transfer adapter | Licensed participation, endpoint, mTLS, signed auth, participant IDs, approvals | Transfer submission remains rejected. |
| TigerBeetle | Go and Rust | Double-entry topology, projection, reconciliation, disabled client | Private cluster, TLS, recovery controls | No account or transfer command is accepted before activation. |
| OpenSearch, lakehouse, Sedona, GeoLibre | Python | Redacted/aggregate contracts and disabled templates | Private services, secrets, governance, retention and privacy review | Raw documents, unapproved geography, and ungoverned sinks are rejected. |
| open-appsec | Edge | Disabled secret-reference template | Approved agent, token, policy, telemetry review | Security controls must not leak customer, document, or monetary data. |

## Classification Summary

| Classification | Components |
|---|---|
| **Implemented and activation-gated** | PostgreSQL, event contracts, Fluvio, Temporal, Keycloak, Permify, Redis, TigerBeetle, APISIX, open-appsec, OpenSearch, lakehouse, Sedona, GeoLibre |
| **Authorised-provider prerequisite** | Mojaloop and regulated payment, FX, KYC, sanctions, and regulator-submission adapters |
| **Data-governance prerequisite** | Lakehouse, OpenSearch, Sedona, GeoLibre, and KYC/KYB evidence processing |

> An implemented adapter, configuration template, or contract does not activate a network connection, provider relationship, financial movement, screening decision, or regulator submission.
