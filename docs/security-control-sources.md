# Security Control Sources

This implementation uses the following official references as design inputs. They are not evidence that any unprovisioned control is live.

| Control | Verified design input | Source |
|---|---|---|
| Keycloak at the API gateway | APISIX supports OIDC against compatible providers, including Keycloak; bearer-only routes reject missing or invalid bearer tokens. | https://apisix.apache.org/docs/apisix/plugins/openid-connect/ |
| API-rate controls | APISIX `limit-count` applies a configurable request count in a time window and can use Redis-backed counters; a dependency outage must not degrade enforcement. | https://apisix.apache.org/docs/apisix/plugins/limit-count/ |
| Gateway-to-identity integration | Keycloak can provide OIDC identity to APISIX routes, with the gateway acting as an OIDC client or protected APIs using bearer-only mode. | https://www.keycloak.org/2021/12/apisix |
| Application protection | open-appsec supports APISIX attachments on Kubernetes, Linux, and Docker. Its attachment can be configured fail-close; deployment and policy activation remain separate external prerequisites. | https://docs.openappsec.io/concepts/agents |
| Gateway policy decisions | APISIX sends protected-route requests to OPA; the selected policy must return an object with an `allow` field. The gateway policy therefore defaults to denial and emits `allow: true` only for an authenticated role and permitted method. | https://apisix.apache.org/docs/apisix/plugins/opa/ |
| Policy distribution | OPA exposes a REST policy and data API, while bundles are the preferred mechanism for policy updates across multiple instances. | https://www.openpolicyagent.org/docs/latest/rest-api/ |

The planned posture is PostgreSQL-only for platform data, Keycloak for identity and MFA, APISIX for API enforcement, OPA for request and purpose policy, and Caddy for public TLS ingress. Neither source documentation nor repository configuration is treated as evidence of a live deployment or licensed counterparty activation.
