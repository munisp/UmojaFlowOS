# UmojaFlowOS Security Stack Composition

This composition is a **cloud-agnostic, non-production deployment template** for the PostgreSQL-only UmojaFlowOS control plane. It puts Caddy on the only public listener and keeps APISIX, OPA, Redis, Keycloak, PostgreSQL, and the control plane on an internal network. It is deliberately unable to start without supplied configuration and managed secrets; no credential, provider endpoint, partner activation, payment authority, or regulatory submission authority is included.

> The manifest is not evidence that any security layer is operating in a production environment. It must be deployed by an approved platform and security team after network policy, image provenance, backups, observability, certificate management, Keycloak MFA enrolment, OPA bundle review, application-role grants, and open-appsec attachment validation are complete.

Before any deployment, run `node infra/security-stack/security-preflight.mjs` with the managed-secret-injected environment. It validates the presence and shape of required values, requires an immutable control-plane image and pinned OPA/Keycloak artifacts, rejects public or plaintext evidence-storage endpoints, and requires a named security approval reference. It emits only configuration key names and reasons; it never prints a secret value. A successful result means only **ready for security-owner review**, not deployed or active.

The `open-appsec` attachment is intentionally not included as a runnable service because it requires a security-owner-managed registration token and prevention-policy attachment. Its required Caddy-to-APISIX placement and activation prerequisites are recorded in `../openappsec/openappsec-deployment-requirements.md`.
