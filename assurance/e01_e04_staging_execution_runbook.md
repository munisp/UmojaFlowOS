# E-01 and E-04 staging execution runbook

This runbook targets the repository revision currently under review. It separates release-artifact generation from evidence validation and does not treat local simulators, local tests, or a dry run as staging evidence.

## 1. Immutable release preparation

Create the release candidate from a clean checkout and record the exact commit before building anything:

```bash
export RELEASE_SHA=2aaf85810a12dd85646d006c27415fb82cd3e4d1
export RELEASE_TAG=umoja-staging-${RELEASE_SHA:0:12}

git fetch origin --tags --prune
git checkout --detach "$RELEASE_SHA"
test "$(git rev-parse HEAD)" = "$RELEASE_SHA"
test -z "$(git status --porcelain)"
```

The release manager must verify the commit is the reviewed `origin/main` revision, record the repository URL, commit SHA, source-tree digest, build timestamp, and operator identity in the release evidence bundle. Do not reuse the earlier SHA if a later portability or ledger-contract commit is being assessed.

## 2. E-01: signed tag, provenance, SBOM, and immutable image identity

The committed `production-release-evidence-gate.yml` is a **validator**. It checks out the supplied immutable `release_ref`, verifies that `HEAD` resolves to that reference, invokes `verify_production_release_evidence.py`, and uploads the manifest. It does not itself create a signed tag, build an image, generate an SBOM, or create a provenance attestation. Those artifacts must be produced by the protected release-build job before the validator is dispatched.

Use a protected signing workstation or an approved release runner. A GPG-signed annotated tag can be created as follows, with the signing identity supplied by the release manager and never committed to the repository:

```bash
git tag -s "$RELEASE_TAG" "$RELEASE_SHA" \
  -m "UmojaFlowOS staging release ${RELEASE_SHA}"
git tag -v "$RELEASE_TAG"
git push origin "$RELEASE_TAG"
```

The tag verification output, signer fingerprint, and the signed-tag object ID belong in E-01. If the organization uses SSH signing or a Sigstore keyless workflow instead of GPG, use the approved organizational procedure and retain the equivalent verifiable signature record; do not silently substitute an unsigned tag.

Build and publish the exact staging image using the protected registry and the repository’s release builder. The image reference must resolve to an immutable digest:

```bash
export IMAGE_REPOSITORY=registry.example.invalid/umoja/payment-engine
export IMAGE_TAG="$RELEASE_TAG"

docker buildx create --name umoja-release-builder --use 2>/dev/null || docker buildx use umoja-release-builder
docker buildx inspect --bootstrap

docker buildx build \
  --file services/payment-engine/Dockerfile \
  --tag "${IMAGE_REPOSITORY}:${IMAGE_TAG}" \
  --push \
  --provenance=mode=max \
  --sbom=true \
  .

docker buildx imagetools inspect "${IMAGE_REPOSITORY}:${IMAGE_TAG}"
```

Replace the example registry host with the approved registry. Capture the resulting `sha256:` image digest, the registry manifest, the provenance attestation, and the SBOM. The build identity must be tied to `RELEASE_SHA`; a mutable tag alone is insufficient. Where the registry supports it, verify the image digest and attestations with the organization’s approved cosign/registry verification command, for example:

```bash
cosign verify-attestation \
  --type slsa.dev/provenance \
  --certificate-identity-regexp 'approved-release-builder' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  "${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"

cosign verify-attestation \
  --type https://spdx.dev/Document \
  --certificate-identity-regexp 'approved-release-builder' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  "${IMAGE_REPOSITORY}@${IMAGE_DIGEST}"
```

The exact certificate identity and issuer must match the protected organization policy. If the build is not signed or the attestations cannot be verified, stop and record E-01 as blocked.

For a single fail-closed verification pass after installing the organization-approved `cosign` and `jq` binaries, run:

```bash
scripts/infra/verify_release_cryptography.sh \
  --repo-dir . \
  --release-sha "$RELEASE_SHA" \
  --tag "$RELEASE_TAG" \
  --image "${IMAGE_REPOSITORY}@${IMAGE_DIGEST}" \
  --certificate-identity-regexp 'approved-release-builder' \
  --certificate-oidc-issuer 'https://token.actions.githubusercontent.com' \
  --expected-gpg-fingerprint '<approved-release-key-fingerprint>' \
  --output-dir "$BUNDLE_DIR/cryptography"
```

The verifier fetches the tag without force, requires an annotated tag, runs `git verify-tag`, checks that the tag resolves exactly to `RELEASE_SHA`, checks the signer fingerprint, verifies the SLSA provenance attestation for the immutable image digest, and requires the verified provenance payload to contain the expected source commit. It writes only tag/provenance verification output and binding metadata to the evidence directory. It intentionally exits nonzero when `cosign`, `jq`, the tag, the signer, the digest, the identity, the issuer, or the source-commit binding is unavailable.

Create the release manifest only after every E-01 artifact has been copied into the controlled evidence directory and SHA256-hashed. The manifest must bind the evidence to the exact `RELEASE_SHA`, use the staging/production environment value required by the verifier, and contain four distinct approval objects with the only permitted fields: `role`, `subject`, `release_sha`, and `approved_at`.

Dispatch the repository validator from GitHub Actions:

```bash
gh workflow run production-release-evidence-gate.yml \
  --repo munisp/UmojaFlowOS \
  --ref "$RELEASE_TAG" \
  -f release_ref="$RELEASE_TAG" \
  -f evidence_manifest='assurance/evidence/release.json'

gh run watch --repo munisp/UmojaFlowOS
```

The validator must pass with a clean immutable checkout, valid E-01–E-09 artifact hashes, the exact SHA binding, and all four independent approvals. A locally generated manifest or a dry-run bundle remains non-production evidence.

## 3. E-04: provision the TigerBeetle staging cluster

The official TigerBeetle deployment procedure uses one statically linked binary and one data file per replica. A mission-critical staging rehearsal should use six replicas in independent fault domains, preferably across three sites with two replicas per site. TigerBeetle’s documented quorum model requires four of six replicas to elect a new primary after primary loss. [1] [2]

Provision six dedicated staging hosts with persistent local storage, stable private addresses, synchronized clocks, restrictive network policy, and an authenticated encrypted transport boundary. The UmojaFlowOS adapter requires TLS in non-loopback deployments and rejects plaintext unless the explicit loopback development exemption is active.

Install and verify the same TigerBeetle binary version on every host:

```bash
curl -fL -o tigerbeetle.zip https://linux.tigerbeetle.com
unzip -o tigerbeetle.zip
./tigerbeetle version
sha256sum ./tigerbeetle
```

Generate a random, nonzero 128-bit cluster ID through the approved secret-generation process. Do not use TigerBeetle’s reserved testing cluster ID `0`. The cluster ID and replica count must be identical on all six replicas; each replica index must be unique from `0` through `5`, and the ordered address list must be identical everywhere. [1]

On each host, format exactly one data file. The following is a command template; replace placeholders only with approved staging values:

```bash
export TB_CLUSTER_ID=<nonzero-128-bit-cluster-id>
export TB_REPLICA_COUNT=6
export TB_REPLICA_INDEX=<0-through-5>
export TB_DATA_FILE=/var/lib/tigerbeetle/${TB_CLUSTER_ID}_${TB_REPLICA_INDEX}.tigerbeetle

sudo install -d -o tigerbeetle -g tigerbeetle -m 0750 /var/lib/tigerbeetle
sudo -u tigerbeetle ./tigerbeetle format \
  --cluster="$TB_CLUSTER_ID" \
  --replica-count="$TB_REPLICA_COUNT" \
  --replica="$TB_REPLICA_INDEX" \
  "$TB_DATA_FILE"
```

Start each replica under the approved supervisor, using exactly the same ordered address list on all hosts:

```bash
export TB_ADDRESSES=<replica-0-host:port,replica-1-host:port,replica-2-host:port,replica-3-host:port,replica-4-host:port,replica-5-host:port>
sudo -u tigerbeetle ./tigerbeetle start \
  --addresses="$TB_ADDRESSES" \
  "$TB_DATA_FILE"
```

Do not expose the TigerBeetle native protocol publicly. Place the client behind the approved mTLS/service-mesh boundary and verify that the payment-engine source address can reach every configured replica address. Record the six replica identities, ordered addresses, binary digest, cluster ID reference (not the secret itself if policy treats it as sensitive), quorum state, and TLS verification result.

Create the staging ledgers and accounts through an approved one-time provisioning program using the official Go client. Record the resulting nonzero NGN ledger ID, account code, transfer code, debit account ID, and credit account ID in the staging secret manager. The debit and credit accounts must be distinct and must be funded/configured for the intended test. Never put those values in Git.

The corrected UmojaFlowOS adapter now accepts decimal or `0x`-prefixed unsigned 128-bit cluster IDs. Validate the parser locally before connecting:

```bash
cd services/payment-engine
go test ./internal/ledger
go build ./cmd/tigerbeetle-loadtest
```

## 4. E-04 ledger validation workflow

Configure these protected GitHub Actions environment secrets in `staging-tigerbeetle-loadtest`:

| Secret | Required value |
|---|---|
| `TIGERBEETLE_STAGING_ADDRESS` | Approved client/mTLS endpoint or ordered endpoint contract used by the adapter |
| `TIGERBEETLE_STAGING_CLUSTER_ID` | Nonzero decimal or `0x`-prefixed unsigned 128-bit cluster ID |
| `TIGERBEETLE_STAGING_NGN_LEDGER` | Nonzero NGN ledger ID |
| `TIGERBEETLE_STAGING_ACCOUNT_CODE` | Nonzero account code |
| `TIGERBEETLE_STAGING_TRANSFER_CODE` | Nonzero transfer code |
| `TIGERBEETLE_STAGING_DEBIT_ACCOUNT_ID` | Nonzero funded debit account ID |
| `TIGERBEETLE_STAGING_CREDIT_ACCOUNT_ID` | Nonzero distinct credit account ID |

Dispatch the committed workflow with an approved immutable payment-engine image digest:

```bash
export IMAGE_DIGEST=registry.example.invalid/umoja/payment-engine@sha256:<64-lowercase-hex-digest>

gh workflow run staging-tigerbeetle-loadtest.yml \
  --repo munisp/UmojaFlowOS \
  --ref "$RELEASE_TAG" \
  -f image_digest="${IMAGE_DIGEST##*@}" \
  -f duration_seconds=60 \
  -f workers=4 \
  -f batch_size=256

gh run watch --repo munisp/UmojaFlowOS
```

The repository workflow currently expects the `image_digest` input to begin with `sha256:` and separately builds the load-test binary. Confirm the supplied workflow input format in the dispatched run; if the workflow is changed to require a complete `registry/repository@sha256:...` reference, use that exact contract instead of guessing.

The run must prove client construction, cluster-ID validation, account/ledger compatibility, batched transfer creation, transfer result handling, idempotent retry behavior, zero unexpected failures, and a persisted JSON load-test report. The report must be retained with the workflow run and linked into E-04. The PostgreSQL/TigerBeetle reconciliation job must then show that every intended fact has a matching ledger fact and that no unexpected facts or field mismatches exist.

For the controlled failover rehearsal, use the repository’s default `plan` mode first:

```bash
TIGERBEETLE_DR_TARGET=staging \
  scripts/infra/tigerbeetle_dr_failover.sh plan
```

Only an approved operations owner may run `execute`, and only with reviewed freeze, fence, quorum, promote, in-flight reconciliation, PostgreSQL/TigerBeetle reconciliation, and resume hooks. Capture the before/after quorum state, freeze/fence evidence, recovery duration, reconciliation result, and alert delivery. An indeterminate result must stop payment execution and remain an E-04/E-08 failure until resolved.

## 5. Acceptance and stop conditions

E-01 is closed only when the signed release reference, SHA-bound image digest, verifiable provenance attestation, SBOM, manifest hashes, and four distinct approvals are present. E-04 is closed only when the real staging cluster passes the connection, account, batched transfer, idempotent retry, reconciliation, and approved failover checks. A simulator, local disposable cluster, workflow syntax pass, or successful compilation is supporting evidence only.

## References

[1]: https://docs.tigerbeetle.com/operating/deploying/ "TigerBeetle: Deploying"
[2]: https://docs.tigerbeetle.com/operating/cluster/ "TigerBeetle: Cluster Recommendations"
[3]: https://docs.tigerbeetle.com/coding/clients/go/ "TigerBeetle: Go client"
