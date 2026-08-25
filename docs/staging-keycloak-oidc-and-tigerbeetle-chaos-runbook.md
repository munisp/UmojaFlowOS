# Staging Keycloak OIDC and TigerBeetle chaos runbook

## Scope and safety

This runbook is for an isolated staging environment. It does not enable Keycloak or TigerBeetle in production, and the chaos runner changes host firewall rules. Use a dedicated change window, an approved staging replica, non-production identities, and an independent operator observing the recovery gates.

## Keycloak realm and client

Create or select the approved realm:

```text
Realm: umojaflowos-staging
Issuer: https://keycloak.staging.internal/realms/umojaflowos-staging
```

Create a confidential browser client for the control-plane login flow:

```text
Client ID: umojaflowos-control-plane-staging
Client authentication: ON
Standard flow: ON
Direct access grants: OFF
Implicit flow: OFF
Valid redirect URI: https://umoja-staging.example.com/api/auth/keycloak/callback
Web origins: https://umoja-staging.example.com
```

For service-to-service bearer validation, use the audience configured for the control plane. Do not put the client secret in Git, browser code, JSONL audit logs, or pull-request secrets.

Create realm roles that map exactly to the application roles:

```text
umojaflowos_admin
umojaflowos_compliance_officer
umojaflowos_treasury_operator
umojaflowos_auditor
```

The application rejects tokens with zero or multiple recognized platform roles. Require MFA through the realm authentication flow and ensure the resulting token includes an `amr` value such as `otp`/`mfa` or an approved `acr` assurance value.

## Control-plane environment

Provision through the staging secret manager or protected workload configuration:

```text
UMOJA_KEYCLOAK_ENABLED=true
UMOJA_KEYCLOAK_ISSUER=https://keycloak.staging.internal/realms/umojaflowos-staging
UMOJA_KEYCLOAK_CLIENT_ID=umojaflowos-control-plane-staging
UMOJA_KEYCLOAK_CLIENT_SECRET=<secret-manager-reference>
UMOJA_KEYCLOAK_AUDIENCE=umojaflowos-control-plane-staging
UMOJA_KEYCLOAK_TLS_REQUIRED=true
UMOJA_KEYCLOAK_FAIL_CLOSED=true
UMOJA_KEYCLOAK_ALLOW_INSECURE_LOOPBACK=false
```

The bearer middleware requires the request header:

```http
X-Umoja-Identity-Provider: keycloak
Authorization: Bearer <access-token>
```

It retrieves JWKS from:

```text
<issuer>/protocol/openid-connect/certs
```

and validates issuer, audience, signature, expiry, recognized single role, subject, and MFA assurance. Invalid or unavailable identity validation returns unauthenticated behavior and never falls back to an administrator identity.

## Keycloak staging integration test

The opt-in test is:

```text
apps/control-plane/server/keycloakFederation.staging.test.ts
```

Run only with an approved staging token:

```bash
cd apps/control-plane
export KEYCLOAK_STAGING_INTEGRATION=true
export KEYCLOAK_STAGING_APPROVED=true
export UMOJA_KEYCLOAK_ISSUER='https://keycloak.staging.internal/realms/umojaflowos-staging'
export UMOJA_KEYCLOAK_AUDIENCE='umojaflowos-control-plane-staging'
export KEYCLOAK_STAGING_BEARER_TOKEN='<short-lived-staging-access-token>'
pnpm exec vitest run server/keycloakFederation.staging.test.ts \
  --pool=threads --poolOptions.threads.singleThread=true
```

The test calls the real discovery and JWKS endpoints and invokes the actual `resolveKeycloakUser` middleware. It checks issuer metadata, JWKS availability, role mapping, MFA assurance, audience, and stable federated subject mapping. It is never run with a production issuer or token.

## TigerBeetle chaos runner

The runner is:

```text
scripts/infra/tigerbeetle_partition_chaos.sh
```

It requires root, `iptables`, an exact approved host name, explicit approval, private target IPs, and a bounded duration. It refuses production mode and automatically removes every INPUT and OUTPUT rule through an exit/signal trap.

Example on an approved staging replica:

```bash
sudo -E env \
  TIGERBEETLE_CHAOS_APPROVED=STAGING_ONLY_APPROVED \
  TIGERBEETLE_CHAOS_CONFIRM_HOST='tb-staging-replica-1.internal' \
  TIGERBEETLE_CHAOS_TARGETS='10.20.30.12:3000,10.20.30.13:3000' \
  TIGERBEETLE_CHAOS_ALLOWED_CIDRS='10.20.30.0/24' \
  TIGERBEETLE_CHAOS_DURATION_SECONDS=30 \
  bash scripts/infra/tigerbeetle_partition_chaos.sh
```

Do not pass DNS names or arbitrary public IPs. The operator must first verify that every target IP is a staging peer and that the target CIDRs do not overlap production networks. The runner injects TCP REJECT rules for the selected peers and removes them after the duration or on interruption.

## Recovery test sequence

1. Record cluster ID, replica IDs, software version, current PostgreSQL reconciliation watermark, and active transfer IDs.
2. Freeze new payment submissions.
3. Start one controlled staging transfer with a deterministic transfer ID.
4. Inject the partition for 30 seconds.
5. Confirm the application reports `indeterminate` or degraded state and does not mark the transfer settled.
6. Verify the old replica cannot accept authoritative writes.
7. Restore connectivity and verify exactly one cluster identity and one writable authority.
8. Retry or look up the interrupted transfer using the original transfer ID.
9. Run the PostgreSQL/TigerBeetle reconciliation job across the outage window.
10. Resume traffic only if quorum, fencing, transfer facts, reconciliation, and audit evidence all pass.

Abort if two writable primaries appear, cluster identity is ambiguous, the deterministic transfer cannot be resolved, reconciliation is indeterminate, or the old primary is not fenced.

## References

The implementation follows the repository’s Keycloak bearer middleware and official TigerBeetle Go adapter. The exact client and batch-transfer test is in `services/payment-engine/internal/ledger/staging_integration_test.go`. The chaos runner is deliberately an orchestration boundary: vendor-specific promotion and fencing commands must be supplied by the staging infrastructure owner and are not invented by this repository.
