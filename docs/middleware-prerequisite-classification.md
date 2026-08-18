# Middleware Prerequisite Classification

## Purpose

This inventory classifies the UmojaFlowOS middleware boundaries by their current implementation state and the prerequisites for activation. It is a deployment-control document, not an authorisation to enable any component.

| Component | Service ownership | Current implementation state | Activation prerequisite | Activation boundary |
|---|---|---|---|---|
| PostgreSQL | TypeScript control plane | Canonical schema, migrations, typed repository procedures, local peer-auth integration tests | Managed production database, backup/restore evidence, restricted network access | PostgreSQL remains control-plane and projection storage; it is not the TigerBeetle monetary source of truth. |
| Kafka and Dapr | Go payment engine; Rust risk and ledger | Versioned envelopes, Go publisher and Rust subscriber contracts | Private event cluster, mTLS, topic ACLs, ordering and duplicate-delivery controls | No broker is assumed active by the contracts. Missing stream input produces a fail-closed Rust outcome. |
| Fluvio | Go and Rust event boundary alternative | Disabled alternative configuration using the same versioned envelopes | Private cluster and mTLS secrets | It must not be enabled alongside Kafka for the same event path without an approved ordering and duplication design. |
| Temporal | Go payment engine | Deterministic workflow configuration validation | Private namespace, task queue, TLS, worker deployment, workflow-operational approval | Workflow configuration does not authorise provider payment activity. |
| Keycloak | TypeScript gateway and edge | Realm import and OIDC claim-mapping boundary | TLS issuer, generated client secret, operator-managed realm | Blank issuer or anonymous routing is rejected. |
| Permify | TypeScript authorisation boundary | Deny-by-default policy model | Private service, schema publication, authenticated policy client | Missing policy input denies access. |
| Redis | Go idempotency boundary | TLS-only configuration and fail-closed store boundary | Private Redis deployment, mTLS, password secret, persistence policy | Unconfigured or unavailable Redis denies idempotency operations. |
| Mojaloop | Go payment adapter | Typed instruction contract and disabled client | Licensed scheme participation, provider endpoint, mTLS, OAuth or signature setup, participant IDs, corridor approvals | Every transfer submission remains rejected until these prerequisites are approved. |
| TigerBeetle | Go payment engine; Rust ledger gateway | Double-entry topology, disabled client, projection and reconciliation boundary | Private cluster ID, addresses, TLS, operational recovery controls | TigerBeetle holds monetary truth only after cluster activation; PostgreSQL remains projection metadata. |
| APISIX | Edge gateway | Fail-closed OIDC route configuration | TLS-protected Keycloak discovery endpoint and valid bearer-token validation | No blank discovery URL or anonymous fallback is allowed. |
| open-appsec | Edge security | Disabled deployment template with secret reference | Approved agent deployment, managed token, protection policy and observability review | Security telemetry must not introduce raw customer, document, or monetary data leakage. |
| OpenSearch | Python reporting analytics | Redacted audit-projection boundary and disabled TLS-only template | Private endpoint, mTLS or credentials in secret manager, redaction validation | Raw documents, monetary values, and credentials are excluded from the indexed projection. |
| Lakehouse | Python reporting analytics | Bronze batch-manifest contract and disabled template | Governed storage, credential secret, retention and data-classification approval | No sink is active solely because a manifest validates. |
| Apache Sedona | Python reporting analytics | Disabled aggregate-processing configuration | Governed geospatial data, private compute, access control and privacy review | Individual-level geographic records require governance approval. |
| GeoLibre | Python reporting analytics | Aggregate-only privacy-safe projection and disabled template | Approved aggregate feed, cohort threshold, jurisdiction controls | Small cohorts and unsupported jurisdictions are rejected. |

## Classification Summary

| Classification | Components |
|---|---|
| **Implemented and activation-gated** | PostgreSQL, Kafka/Dapr contracts, Fluvio, Temporal, Keycloak, Permify, Redis, TigerBeetle, APISIX, open-appsec, OpenSearch, lakehouse, Sedona, GeoLibre |
| **Authorised-provider prerequisite** | Mojaloop, regulated payment/FX/KYC/sanctions/regulatory-submission adapters |
| **Data-governance prerequisite** | Lakehouse, OpenSearch, Sedona, GeoLibre, KYC/KYB evidence processing |
| **No automatic activation** | Every component in this inventory |

> An implemented adapter, configuration template, or contract does not activate a network connection, provider relationship, financial movement, screening decision, or regulator submission.
