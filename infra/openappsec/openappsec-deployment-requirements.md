# open-appsec Deployment Requirements

open-appsec is an ingress web-application firewall control. It is not active merely because these files exist. Before attaching it to APISIX, an approved security owner must provide a deployment-specific registration token through secret storage, a prevention policy, the APISIX attachment, private egress rules, alert routing, and a tested fail-close response for an unavailable enforcement component.

The attachment must protect the Caddy-to-APISIX edge, never bypass Keycloak, OPA, APISIX rate limits, PostgreSQL role checks, provider activation gates, or the non-executable payment controls.
