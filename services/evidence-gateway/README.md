# Local Keycloak-authenticated evidence gateway

This disposable stack tests the portable evidence-upload contract with Keycloak-issued JWTs and MinIO’s S3-compatible Object Lock API. It is local test infrastructure only; it does not produce real release evidence.

## Run

```bash
scripts/infra/run_evidence_gateway_contracts.sh
```

The stack exposes Keycloak at `http://127.0.0.1:8180`, MinIO at `http://127.0.0.1:9000`, and the gateway at `http://127.0.0.1:8280`. The test realm is imported from `infra/evidence-gateway/keycloak/realm-export.json` and contains only synthetic local credentials.

## JWT contract

The gateway validates RS256 JWTs using the Keycloak JWKS endpoint. It requires `iss`, `aud`, `sub`, `iat`, and `exp`, checks issuer and audience, rejects unsupported algorithms and unknown key IDs, and requires the `evidence.publish` realm role. The local realm adds an explicit `umoja-evidence-publisher` audience claim.

Dynamic evidence claims are optional. If present, `evidence_release_sha` and `evidence_run_id` must exactly match the request. The authoritative binding is the read-only server-side release mapping file, which maps one active full SHA and run ID to the fixed `umoja/releases` prefix. Callers cannot select a bucket or prefix.

## Upload contract

```http
PUT /v1/evidence/<40-char-lowercase-sha>/<run-id>/<relative-object-path>
Authorization: Bearer <Keycloak-access-token>
X-Evidence-SHA256: <sha256-of-request-body>
Content-Type: application/json
```

The gateway rejects malformed paths, traversal, inactive releases, run mismatches, missing roles, invalid JWTs, and body-digest mismatches. Successful uploads use AES256 encryption, `COMPLIANCE` retention, release/run metadata, and `umoja-immutable=true` object tagging.

## Test boundaries

The pytest suite tests a real Keycloak token exchange, JWT verification, server-side SHA mapping, digest enforcement, path rejection, and MinIO storage. It is opt-in and requires Docker. Local credentials are synthetic and must never be reused outside this stack.
