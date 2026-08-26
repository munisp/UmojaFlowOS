# Production Keycloak and Vault controls for evidence publishing

## Security profile

Use a dedicated confidential OpenID Connect client for automated evidence publishing. Disable direct access grants, implicit flow, standard browser flow, refresh tokens, and unused scopes. Grant only a realm or client role named `evidence.publish`.

Recommended realm session values are short-lived for this high-integrity operation:

```text
accessTokenLifespan:              300 seconds
accessTokenLifespanForImplicitFlow: disabled/not used
ssoSessionIdleTimeout:            1800 seconds
ssoSessionMaxLifespan:            28800 seconds
clientSessionIdleTimeout:         900 seconds
clientSessionMaxLifespan:         3600 seconds
offlineSessionIdleTimeout:        disabled for publisher
revokeRefreshToken:               true
refreshTokenMaxReuse:             0
```

The evidence gateway must validate `iss`, `aud`, `exp`, `iat`, `nbf` when present, `sub`, the RS256 signature from the realm JWKS, and the `evidence.publish` role. Keep clock skew at five seconds or less. Require a new client-credentials token per upload run; do not use refresh tokens for CI publication.

The client should have one narrowly scoped client scope containing only the audience mapper and the role claim. Do not grant `profile`, `email`, `offline_access`, `roles` beyond the required publisher role, or administrative scopes.

## Keycloak client configuration

```json
{
  "clientId": "umoja-evidence-publisher",
  "enabled": true,
  "protocol": "openid-connect",
  "publicClient": false,
  "clientAuthenticatorType": "client-secret",
  "serviceAccountsEnabled": true,
  "directAccessGrantsEnabled": false,
  "standardFlowEnabled": false,
  "implicitFlowEnabled": false,
  "serviceAccountsRoles": {
    "realm": ["evidence.publish"]
  },
  "protocolMappers": [
    {
      "name": "evidence-publisher-audience",
      "protocol": "openid-connect",
      "protocolMapper": "oidc-audience-mapper",
      "config": {
        "included.client.audience": "umoja-evidence-publisher",
        "access.token.claim": "true",
        "id.token.claim": "false"
      }
    }
  ]
}
```

Store the generated client secret only in Vault. Do not commit it to a realm export, GitHub variable, workflow file, image, or evidence bundle.

## GitHub OIDC to Vault

Create a Vault JWT auth role with a bound audience and exact repository/environment subject:

```text
auth method: jwt
bound_issuer: https://token.actions.githubusercontent.com
bound_audiences: https://vault.example.org
bound_claims.sub: repo:munisp/UmojaFlowOS:environment:production-release-evidence
policies: umoja-keycloak-evidence-rotation
```

The policy should permit only the required paths:

```hcl
path "secret/data/umoja/keycloak/admin" {
  capabilities = ["read"]
}

path "secret/data/umoja/keycloak/evidence-publisher" {
  capabilities = ["create", "update", "read"]
}

path "secret/metadata/umoja/keycloak/evidence-publisher" {
  capabilities = ["read"]
}
```

Use a protected GitHub environment with `id-token: write`. GitHub OIDC authenticates the workflow to Vault; Vault returns a short-lived Vault token; the workflow reads the Keycloak admin client credential and writes the newly rotated evidence-publisher secret back to Vault. No long-lived GitHub secret is required for the rotation job.

## Secret rotation sequence

1. Protect the rotation workflow with the `production-release-evidence` environment and required reviewers.
2. Authenticate the workflow to Vault using the GitHub OIDC JWT.
3. Read the dedicated Keycloak administration client credential from Vault.
4. Request a new client secret from the Keycloak Admin API.
5. Store the new value in Vault using a compare-and-set/versioned KV write.
6. Obtain a fresh client-credentials token with the new secret.
7. Perform a harmless gateway health/authentication probe and upload a non-production canary only to the approved canary prefix.
8. Revoke the old secret only after the canary succeeds and the rollout window is approved. If Keycloak supports dual-secret overlap in the deployed version, use overlap; otherwise coordinate an atomic consumer restart.
9. Record only secret version IDs, timestamps, Keycloak client ID, release SHA, and verification results. Never record the secret itself.

The rotation must fail closed if Vault is unavailable, the Keycloak response lacks a new secret, the KV version does not advance, the new token is rejected, the canary upload fails, or the old-secret revocation cannot be proven.

## Verification checklist

```bash
vault read auth/jwt/role/umoja-keycloak-evidence-rotation
vault policy read umoja-keycloak-evidence-rotation

curl --fail --silent --show-error \
  "$KEYCLOAK_BASE_URL/realms/$KEYCLOAK_REALM/.well-known/openid-configuration" \
  | jq -e --arg issuer "$KEYCLOAK_BASE_URL/realms/$KEYCLOAK_REALM" '.issuer == $issuer'

curl --fail --silent --show-error \
  "$KEYCLOAK_BASE_URL/realms/$KEYCLOAK_REALM/protocol/openid-connect/certs" \
  | jq -e '.keys | length > 0'
```

Decode a canary token only on a protected review host and verify that `aud` is the evidence client and the role set contains only the intended publisher role. Do not log the token or its full claims in CI.

## Separation of concerns

Keycloak authenticates and authorizes the publisher. Vault protects the client secret and rotation authority. The evidence gateway enforces the server-side release SHA/run mapping. The object store enforces versioning and WORM retention. None of these layers should trust a release SHA or bucket prefix supplied solely by the client.
