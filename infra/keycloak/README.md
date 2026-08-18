# Keycloak realm boundary

Import `realm-umojaflowos.json` only into a TLS-protected Keycloak deployment controlled by the platform security owner. The client secret is intentionally omitted and must be generated in Keycloak, stored in a managed secret store, and injected into APISIX and approved server workloads.

The realm defines only `admin`, `compliance_officer`, `treasury_operator`, and `auditor`. The application claim mapper is deny-by-default; unknown roles must not acquire platform permissions.
