# Keycloak realm boundary

Import `realm-umojaflowos.json` only into a TLS-protected Keycloak deployment controlled by the platform security owner. The client secret is intentionally omitted and must be generated in Keycloak, stored in a managed secret store, and injected into APISIX and approved server workloads.

The realm defines only `admin`, `compliance_officer`, `treasury_operator`, and `auditor`. The application claim mapper is deny-by-default; unknown roles must not acquire platform permissions.

## `umojaflowos-admin-api` client

Backs the console's "onboard operator" action (Governance → Operator access), which creates the operator's identity-provider account directly instead of requiring separate Keycloak-console access. It is a service-account client scoped to `manage-users` only — never `admin-cli` and never the broad `realm-admin` role — so a compromised application credential cannot manage realm settings, other clients, or roles beyond creating/reading users. Its secret is generated in Keycloak the same way as the gateway client's, stored in the managed secret store, and injected as `UMOJA_KEYCLOAK_ADMIN_CLIENT_ID` / `UMOJA_KEYCLOAK_ADMIN_CLIENT_SECRET`. Leaving those unset disables the feature rather than failing sign-in: the console falls back to its existing "grant a role once someone has already signed in" path.
