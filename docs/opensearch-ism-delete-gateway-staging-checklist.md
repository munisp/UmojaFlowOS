# OpenSearch ISM Delete Gateway — Staging Verification Checklist

## Scope and safety boundary

This procedure must run only against an isolated staging OpenSearch cluster, a staging retention gateway, synthetic audit events, a test-only ISM policy, a test-only index pattern, and a mock retention-notification receiver. Never shorten the production policy, reuse a production alias, use real customer records, or point the test notification URL at a production service.

The retention gateway is the deletion authorization boundary. OpenSearch ISM may request authorization, but the gateway must return an authorization only after all hold, WORM, completeness, retention-expiry, approval, and integrity checks pass. A timeout, unknown status, missing object, invalid signature, or ambiguous scope must deny or fail closed.

## Required staging variables

| Variable | Requirement |
|---|---|
| `OPENSEARCH_URL` | Isolated HTTPS OpenSearch endpoint |
| `OPENSEARCH_USER` / `OPENSEARCH_PASSWORD` | Test-only least-privilege credentials |
| `RETENTION_GATEWAY_URL` | Staging gateway URL; HTTPS except loopback-only tests |
| `RETENTION_GATEWAY_TOKEN` | Test token injected from the staging secret manager |
| `BUILD_ID` | Unique run identifier to avoid alias/index collisions |

The automated script is:

```bash
BUILD_ID="${GITHUB_RUN_ID:-manual-$(date +%s)}" \
OPENSEARCH_URL="https://opensearch.staging.example" \
OPENSEARCH_USER="$OPENSEARCH_USER" \
OPENSEARCH_PASSWORD="$OPENSEARCH_PASSWORD" \
RETENTION_GATEWAY_URL="https://retention-gateway.staging.example" \
RETENTION_GATEWAY_TOKEN="$RETENTION_GATEWAY_TOKEN" \
./scripts/infra/verify_opensearch_ism_delete_staging.sh
```

## Policy and index setup

1. Create a test policy with a unique policy ID and short non-production timers, for example `hot → warm` after one minute and `warm → delete` after three minutes.
2. Use a unique pattern such as `umoja-security-audit-delete-test-${BUILD_ID}-*`.
3. Configure a mock retention gateway notification receiver. It must record the callback and return success without deleting anything external.
4. Install the test policy through `PUT /_plugins/_ism/policies/{policy_id}`.
5. Install a test index template containing the test policy ID, test rollover alias, mappings, and a non-production index pattern.
6. Bootstrap `...-000001` and mark the test alias as `is_write_index: true`.
7. Query `/_alias/{alias}` and `/_plugins/_ism/explain/{index}`. Save both responses as evidence.

## Positive and negative test matrix

| Case | Setup | Expected result | Must prove |
|---|---|---:|---|
| Valid authorization | No active hold; archive exists; Object Lock expired; digest/signature/completeness valid; independent approval exists | HTTP `202`, `authorized` | Token is bound to exact index, UUID, version, digest, and short expiry |
| Active legal hold | Hold registry returns active hold for the exact index or scope | HTTP `409`, `hold_active` | No delete request is executed |
| Unknown hold state | Hold provider times out or returns unknown | HTTP `409` or `503`, never `202` | Fail-closed behavior |
| Retention not expired | WORM `retain_until` is in the future | HTTP `412`, `worm_not_verified` | No authorization is issued |
| WORM object missing | Archive metadata lookup returns not found | HTTP `412` or `503` | No deletion occurs |
| Digest mismatch | Archive SHA-256 differs from requested digest | HTTP `412`, `worm_not_verified` | Mismatch is recorded with correlation ID |
| Invalid detached signature | Signature verification fails | HTTP `412`, `worm_not_verified` | No deletion occurs |
| Incomplete archive | Document count, sequence range, or time range differs | HTTP `412`, `worm_not_verified` | Partial archive cannot authorize deletion |
| Active Object Lock | Object Lock retention is still active | HTTP `412`, `worm_not_verified` | Gateway does not override storage retention |
| Self-approval | Requester is also the deletion approver | HTTP `409`, `approval_required` | Segregation of duties is enforced |
| Ambiguous scope | Request omits physical index, UUID, version, or digest | HTTP `422`, `scope_ambiguous` | Alias-only deletion is refused |
| Provider outage | Hold, WORM, or approval dependency returns an error | HTTP `503`, `verification_error` | Unknown is never treated as clear |
| Duplicate request | Repeat the same exact authorized request | HTTP `200`, `already_deleted` | Same decision digest is returned; no second authorization side effect |
| Changed digest | Reuse request with a different digest | Non-success denial | Authorization cannot be replayed for another object |
| Concurrent hold | Create a hold between eligibility evaluation and authorization | Denial or authorization transaction abort | Hold creation wins over deletion authorization |

## Transition evidence

Record the following at every polling interval:

```bash
curl --fail-with-body -u "$OPENSEARCH_USER:$OPENSEARCH_PASSWORD" \
  "$OPENSEARCH_URL/_plugins/_ism/explain/$INDEX?pretty" \
  | tee "evidence/${BUILD_ID}-ism-explain.json"

curl --fail-with-body -u "$OPENSEARCH_USER:$OPENSEARCH_PASSWORD" \
  "$OPENSEARCH_URL/_cat/indices/$INDEX?v" \
  | tee "evidence/${BUILD_ID}-index-state.txt"
```

Expected sequence:

1. The index starts in `hot`.
2. The rollover alias points to the current write index.
3. At the test age threshold, ISM moves the index to `warm`.
4. The warm action marks the index read-only and applies the configured replica count.
5. At the delete threshold, the retention notification is received by the mock gateway.
6. The delete action removes the test physical index.
7. The alias no longer points to the deleted index.

Because ISM is scheduler-driven, allow the configured interval plus a documented grace period. Do not manually delete the index to make the test pass.

## Gateway authorization evidence

For every decision, retain:

- Request body and correlation ID.
- Exact physical index, index UUID, generation/version, and expected digest.
- Hold-provider result and hold IDs.
- WORM object key/version, Object Lock mode, `retain_until`, legal-hold status, archive digest, signature-key version, and completeness result.
- Independent approver identity and approval digest.
- Canonical decision digest and verifier version.
- HTTP response code and decision code.
- For an authorization, token expiry, exact scope binding, and single-use consumption record.
- For a denial, proof that no OpenSearch deletion call was made.

Never place credentials, raw customer records, private document bytes, or full payment/account data in the evidence log.

## Cleanup and release gates

The test is a failure if any negative case returns `202`, if the index is deleted while a hold is active, if the gateway authorizes an unexpired or unverifiable archive, if a self-approval succeeds, or if a provider outage is treated as a clear result.

After the run, delete the test index/template/policy, remove the test credentials, stop the mock receiver, and preserve the evidence bundle in the approved staging evidence store. Production enablement requires independent review of the retention period, legal-hold scope model, Object Lock configuration, signature-key lifecycle, deletion approvals, legal holds, and legal requirements.
