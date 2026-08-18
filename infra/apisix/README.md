# Apache APISIX gateway boundary

This declarative route configuration is deliberately **fail-closed**. Every service route requires the `KEYCLOAK_OIDC_DISCOVERY_URL` environment value, a reachable TLS-protected Keycloak issuer, and a valid bearer token. Do not deploy it with a blank discovery URL or replace the OIDC plugin with an anonymous route.

The upstream names are cluster-internal DNS names, not public provider endpoints. The configuration does not activate payment execution, sanctions screening, regulatory submission, or TigerBeetle posting; each downstream service maintains its own provider and policy gates.

Open-appsec must be deployed as a separately managed reverse-proxy or agent enforcement layer after its policy bundle, management endpoint, and operational ownership are approved. It must protect the APISIX ingress and must not be treated as an application authorization substitute.
