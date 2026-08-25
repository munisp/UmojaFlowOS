# Staging replacement and AML failover runbook

## Scope

The production-dependency simulator is a local/CI contract harness. Staging must replace it with approved real services while keeping all activation flags disabled until the corresponding control evidence is accepted.

## Keycloak OIDC

Provision a private TLS Keycloak realm and client, then set only secret-managed deployment variables:

```text
UMOJA_KEYCLOAK_ENABLED=true
UMOJA_KEYCLOAK_ISSUER=https://keycloak.staging.internal/realms/umojaflowos
UMOJA_KEYCLOAK_AUDIENCE=umojaflowos-control-plane
UMOJA_KEYCLOAK_TLS_REQUIRED=true
UMOJA_KEYCLOAK_FAIL_CLOSED=true
```

The application must validate issuer, audience, signature algorithm, `exp`, `nbf`, and JWKS over a verified TLS connection. Do not place client secrets or signing private keys in the repository. The Keycloak client should be bearer-only for API access, use least-privilege roles, and have administrator/bootstrap credentials injected through an external secret manager.

Staging verification:

```bash
curl --fail --silent --show-error \
  --cacert /etc/umoja/ca/keycloak-ca.pem \
  https://keycloak.staging.internal/realms/umojaflowos/.well-known/openid-configuration
```

Do not enable the flag until discovery, JWKS rotation, invalid signature, expired token, wrong audience, and revoked-role tests pass.

## TigerBeetle

Provision a persistent private cluster with approved replicas, backups, TLS/service-mesh controls, and a reconciled PostgreSQL projection. Set:

```text
UMOJA_TIGERBEETLE_ENABLED=true
UMOJA_TIGERBEETLE_CLUSTER_ID=<secret-manager-reference>
UMOJA_TIGERBEETLE_ADDRESSES=<private-tls-address-list>
UMOJA_TIGERBEETLE_NGN_LEDGER=<approved-ledger-id>
UMOJA_TIGERBEETLE_KES_LEDGER=<approved-ledger-id>
UMOJA_TIGERBEETLE_ZAR_LEDGER=<approved-ledger-id>
UMOJA_TIGERBEETLE_ACCOUNT_CODE=<approved-account-code>
UMOJA_TIGERBEETLE_TRANSFER_CODE=<approved-transfer-code>
UMOJA_TIGERBEETLE_TLS_REQUIRED=true
UMOJA_TIGERBEETLE_ALLOW_INSECURE_LOOPBACK=false
UMOJA_TIGERBEETLE_FAIL_CLOSED=true
```

The Go adapter must use the official TigerBeetle client, map each currency to its approved ledger, enforce idempotent transfer identity, and write PostgreSQL projection/reconciliation evidence. A timeout, unknown account, cluster-unreachable state, duplicate identity mismatch, or projection mismatch must refuse posting and never report settlement.

Staging gates are account-topology verification, balanced debit/credit tests for NGN/KES/ZAR, duplicate replay, reversal/void behavior, cluster failover, PostgreSQL reconciliation, and an operator-approved controlled test. Only then should the flag be enabled.

## AML timeout and failover tests

`simulators/production_dependencies/aml_client.py` implements the fail-closed client contract. It tries configured endpoints in order, uses a bounded timeout, fails over to the secondary endpoint for transport/HTTP/JSON errors, and returns `indeterminate` with `review_required=true` if all endpoints fail.

Run the live-local integration tests:

```bash
cd /home/ubuntu/UmojaFlowOS
pytest -q tests/simulators/test_aml_failover.py
```

The tests start real local HTTP servers and verify:

```text
primary timeout → secondary provider result is returned
primary/secondary outage → indeterminate, manual review required
```

A real AML implementation must preserve provider name, list version, screening timestamp, request identity, response digest, retry count, and failure reason. It must not convert provider unavailability into `clear`, silently change providers without evidence, or automatically approve a customer after a timeout.
