# Real staging evidence collection and independent sign-off

This runbook targets one immutable release SHA and never promotes local, simulator, or contract-test output to real staging evidence. The collection script is an orchestrator and gatekeeper: it can invoke configured real checks, but it cannot invent external results, credentials, signatures, image digests, or approvals.

## 1. Prepare the immutable release

```bash
export RELEASE_SHA=c21cbb7b023a20ad1dde0293b46a96a67b1fe6d6
export RUN_ID="staging-evidence-$(date -u +%Y%m%dT%H%M%SZ)"
export EVIDENCE_DIR="/secure-release-evidence/${RELEASE_SHA}/${RUN_ID}"

git fetch origin --tags --prune
git checkout --detach "$RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
```

The evidence directory must be an approved external mount and must not be inside the Git worktree. The collection script records only non-secret metadata and command results.

## 2. Run the preflight without contacting staging

```bash
scripts/infra/collect_staging_evidence.sh \
  --release-sha "$RELEASE_SHA" \
  --evidence-dir "$EVIDENCE_DIR"
```

Preflight is expected to exit nonzero and mark every item blocked. It confirms the output location and demonstrates that no staging system is contacted before the execution authorization is supplied.

## 3. Configure the protected execution inputs

The following values must be injected by the approved staging runner or secret manager. They must not be committed, echoed, or placed in the evidence bundle:

| Input | Purpose |
|---|---|
| `STAGING_EVIDENCE_APPROVED=EXECUTE_APPROVED_STAGING_EVIDENCE_COLLECTION` | Explicit approved execution marker |
| `E01_TAG` | Signed annotated release tag |
| `E01_IMAGE` | Registry image reference ending in an immutable `@sha256:` digest |
| `E01_GPG_FINGERPRINT` | Approved release signing fingerprint |
| `E01_CERTIFICATE_IDENTITY` | Approved provenance certificate identity regexp |
| `E01_CERTIFICATE_ISSUER` | Approved provenance OIDC issuer |
| `POSTGRES_DATABASE_URL` | Secret-backed TLS schema-owner URL for E-02 |
| `STAGING_E02_APPROVED=STAGING_SCHEMA_MIGRATION` | Explicit schema-migration authorization |

E-04 additionally requires the protected TigerBeetle staging address, nonzero 128-bit cluster ID, ledger ID, account and transfer codes, and distinct funded test accounts. E-06 requires approved kubeconfig and immutable image digest. E-07 requires live monitoring endpoints and delivery authorization. E-08 requires an approved backup/restore target, Chaos execution window, recovery authorization, and cleanup plan. E-05 requires real identity, provider, AML/CFT, regulatory, WORM, and notification endpoints. E-09 requires an independent security-owner review.

## 4. Execute the collection gate

Run this only inside the approved staging window:

```bash
scripts/infra/collect_staging_evidence.sh \
  --release-sha "$RELEASE_SHA" \
  --evidence-dir "$EVIDENCE_DIR" \
  --execute
```

The script verifies the checkout and clean worktree, runs the cryptographic E-01 verifier when all protected inputs are present, invokes the canonical E-02 migration/schema gate when the approved database inputs are present, and records explicit blockers for E-03–E-09 when their real runners and approvals are not configured. It exits nonzero whenever any item remains blocked. A zero exit is not sufficient by itself; the manifest verifier must also validate all nine hash-bound artifacts and four approvals.

After each configured runner completes, review:

```bash
cat "$EVIDENCE_DIR/collection-status.tsv"
sha256sum "$EVIDENCE_DIR"/**/* > "$EVIDENCE_DIR/SHA256SUMS" 2>/dev/null || true
```

Never use shell globbing or a recursive hash command that might include credentials. The final evidence manifest should be assembled from explicitly enumerated non-secret files and should contain the exact SHA256 of each artifact.

## 5. Generate the four approval objects only after authorization

The generator requires a separate owner authorization record. The record must be created by the release-governance process, not by this script. Its minimum structure is:

```json
{
  "authorization_status": "AUTHORIZED_FOR_RELEASE_SIGNOFF",
  "release_sha": "ad2722423a58d7e2d2ba883fb58d737159c51365",
  "authorized_at": "2026-08-26T12:00:00Z",
  "owners": [
    {
      "role": "release_manager",
      "subject": "real-distinct-authorized-subject",
      "approved_at": "2026-08-26T12:01:00Z"
    },
    {
      "role": "security_owner",
      "subject": "real-distinct-authorized-subject",
      "approved_at": "2026-08-26T12:02:00Z"
    },
    {
      "role": "compliance_owner",
      "subject": "real-distinct-authorized-subject",
      "approved_at": "2026-08-26T12:03:00Z"
    },
    {
      "role": "operations_owner",
      "subject": "real-distinct-authorized-subject",
      "approved_at": "2026-08-26T12:04:00Z"
    }
  ]
}
```

Generate the approval array only after all four owners have independently reviewed the same immutable evidence bundle:

```bash
scripts/infra/generate_signoff_approvals.py \
  --release-sha "$RELEASE_SHA" \
  --authorization-record "$EVIDENCE_DIR/approver-authorization.json" \
  --output "$EVIDENCE_DIR/approvals.json"
```

The generator rejects an unauthorized record, SHA mismatch, missing role, duplicate role, duplicate subject, placeholder subject, future approval timestamp, malformed timestamp, or owner set other than the four required roles. It emits only the schema-permitted approval fields: `role`, `subject`, `release_sha`, and `approved_at`.

## 6. Verify the completed manifest

The final manifest must contain all E-01 through E-09 artifacts, their exact relative paths, SHA256 values, run IDs, the staging environment, the exact release SHA, and the generated approvals:

```bash
python3 scripts/infra/verify_production_release_evidence.py \
  --manifest "$EVIDENCE_DIR/release.json" \
  --expected-sha "$RELEASE_SHA"
```

The verifier must exit zero only when every artifact exists and hashes correctly, the repository is bound to the same immutable release, and all four distinct approval roles are present and SHA-bound. A generated approval array without the corresponding nine verified staging artifacts is not sufficient for release.

## Current state

The collection scripts have been syntax-checked and tested in preflight mode. Approval generation was tested only with synthetic non-authorizing identities to validate schema shape. No real staging systems, signing keys, registries, approvers, or external credentials were accessed. Therefore the current release remains **NO-GO** until the controlled runner produces real E-01–E-09 artifacts and the four authorized owners sign the exact bundle.
