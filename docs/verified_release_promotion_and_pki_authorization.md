# Verified Release Promotion and PKI Authorization

## Scope

`scripts/infra/promote_verified_release.sh` promotes one immutable release digest through the pre-existing Istio stable/canary `VirtualService`. It is fail-closed: it does not create evidence, infer authorization, open the settlement fence, or convert an incomplete rollback into a successful release.

The production promotion path requires both cryptographic release evidence and independently supplied PKI revocation evidence. Repository-local fixtures and repository-local authorization directories are not valid production inputs.

## Required inputs

```bash
export RELEASE_REF=f10501f
export RELEASE_TAG=v1.0.0
export EVIDENCE_MANIFEST=/secure/evidence/release_evidence_manifest.json
export IMAGE_REF=registry.example/umoja/payment-engine@sha256:<64-lowercase-hex>
export CERT_IDENTITY_REGEXP='^https://github.com/munisp/UmojaFlowOS/.github/workflows/.*$'
export CERT_OIDC_ISSUER=https://token.actions.githubusercontent.com
export EXPECTED_GPG_FINGERPRINT=<approved-fingerprint>
export NAMESPACE=umoja-payment
export RELEASE_NAME=umoja-payment-engine
export CHART_DIR=/home/ubuntu/UmojaFlowOS-repo/deploy/helm/umoja-payment-engine
export VIRTUALSERVICE_NAME=umoja-payment-engine
export CANARY_HOST=payments-canary.example
export CANARY_VERIFY_SCRIPT=/secure/canary/verify_payment_engine_canary.sh
export AUTHORIZED_DIRECTORY=/secure/pki/authorized-role-subjects.json
export PROMOTION_APPROVED=APPROVED_STAGING_CANARY
export PRODUCTION_APPROVED=APPROVED_PRODUCTION_PROMOTION

scripts/infra/promote_verified_release.sh
```

The promotion script invokes the sidecar verifier with:

```bash
python3 scripts/infra/verify_role_sidecar_authorization.py \
  --manifest "$EVIDENCE_MANIFEST" \
  --signatures-dir "$(dirname "$EVIDENCE_MANIFEST")/signatures" \
  --authorized-directory "$AUTHORIZED_DIRECTORY" \
  --require-revocation-evidence
```

## PKI authorization and revocation model

The authorization directory is an external, authenticated, independently audited PKI export or directory response. It must contain four role entries and signed CRL material:

```json
{
  "directory_version": "2026-09-02",
  "issuer": "https://pki.example/umoja",
  "crl_pem_b64": "<base64-encoded-PEM-or-DER-X.509-CRL>",
  "crl_issuer_certificate_der_b64": "<base64-encoded-DER-issuer-certificate>",
  "revoked_serials": [],
  "roles": {
    "release_manager": [
      {
        "subject": "release-manager-authorized-subject",
        "public_key_sha256": "<sha256-of-32-byte-raw-ed25519-key>",
        "certificate_serial": "123456789",
        "status": "active",
        "revoked_at": null,
        "not_before": "2026-01-01T00:00:00Z",
        "not_after": "2027-01-01T00:00:00Z",
        "certificate_der_b64": "<base64-DER-role-certificate>",
        "issuer_certificate_der_b64": "<base64-DER-issuer-certificate>",
        "ocsp_url": "https://pki.example/ocsp",
        "ocsp_max_age_seconds": 3600
      }
    ],
    "security_owner": [],
    "compliance_owner": [],
    "operations_owner": []
  }
}
```

The verifier binds role, subject, raw Ed25519 public-key SHA-256 digest, certificate serial, manifest release SHA, and validity period. It validates that the CRL is syntactically valid, signed by the declared issuer certificate, currently valid, and that the role certificate serial is not revoked. Entries with `status` other than `active` or a non-null `revoked_at` are rejected.

With `--require-revocation-evidence`, every role must also supply an HTTPS OCSP responder, the role certificate DER, and issuer certificate DER. The verifier submits a standards-based OCSP request, requires a successful response with `GOOD` certificate status, verifies that the response serial matches the role certificate, and rejects stale, malformed, unknown, revoked, or transport-failed responses.

Any absent, malformed, expired, unverifiable, stale, revoked, or ambiguous revocation evidence blocks promotion.

## Current implementation paths

The production verifier and tests are located at:

```text
scripts/infra/verify_role_sidecar_authorization.py
scripts/infra/test_verify_role_sidecar_authorization.py
```

The promotion and routing assets are located at:

```text
scripts/infra/promote_verified_release.sh
scripts/infra/run_kind_canary_promotion_integration.sh
deploy/helm/umoja-payment-engine/templates/service.yaml
deploy/helm/umoja-payment-engine/templates/virtualservice.yaml
deploy/helm/umoja-payment-engine/values.yaml
```

## Promotion stages

```text
cryptographic release verification
→ reject local-fixture provenance
→ verify PKI-authorized subjects, keys, signed CRL, and OCSP status
→ verify manifest, E-01–E-09, WORM, approvals, and GO gate
→ install canary release at the immutable digest
→ wait for Deployment readiness
→ shift configured canary percentage through existing Istio VirtualService
→ run executable canary probe
→ install identical digest as stable production release
→ wait for stable rollout
→ shift 100% traffic to stable
→ capture Deployment and VirtualService evidence
→ remove canary
```

The VirtualService must expose stable at HTTP route index `0` and canary at route index `1`. The promotion script does not create or infer this topology; it refuses to proceed when the required routing contract is absent.

## Kind/Istio integration rehearsal

The disposable routing and rollback rehearsal is:

```bash
scripts/infra/run_kind_canary_promotion_integration.sh
```

It creates a Kind cluster, installs Istio, deploys stable and canary workloads, creates Gateway/DestinationRule/VirtualService resources, verifies initial stable routing, shifts traffic to canary, injects the failure condition, restores stable 100%/canary 0%, and writes evidence to:

```text
artifacts/staging/kind-canary-promotion/weighted-routing.txt
artifacts/staging/kind-canary-promotion/rollback-virtualservice.yaml
artifacts/staging/kind-canary-promotion/status.txt
```

Required local tools are `kind`, `kubectl`, and `curl`. For manual inspection, set `KEEP_CLUSTER=1`; remove the cluster afterward with:

```bash
kind delete cluster --name umoja-canary-it
```

This rehearsal validates routing and rollback mechanics. It does not replace the authorized staging run, production evidence gate, signed release manifest, four-role approvals, or an operator-reviewed payment-engine canary probe.

## Rollback

Any failed command triggers an exit trap that attempts to restore stable traffic to 100%, canary traffic to 0%, and uninstall the canary Helm release. The script never opens the settlement fence or marks a failed rollout successful. If rollback itself fails, operators must immediately fence settlement and restore the VirtualService under the incident procedure.

## Required pre-production tests

Before production use, execute and retain evidence for:

- invalid image digest;
- missing approval flags;
- local-fixture manifest;
- unauthorized subject;
- wrong public-key digest;
- expired or not-yet-valid PKI entry;
- invalid CRL signature;
- expired or malformed CRL;
- revoked certificate serial;
- inactive or explicitly revoked directory entry;
- OCSP timeout or TLS failure;
- malformed OCSP response;
- OCSP `REVOKED` or `UNKNOWN` status;
- mismatched OCSP certificate serial;
- stale OCSP response;
- invalid sidecar signature;
- canary readiness failure;
- canary probe failure;
- stable rollout failure;
- VirtualService patch failure;
- rollback failure;
- identical stable/canary image digest; and
- prevention of an `OPEN` command from a resolved alert.

The regulatory state remains **NO-GO** until the live staging rehearsal, immutable evidence capture, independent PKI authorization, four-role approvals, and E-01–E-09 production GO gate have all passed.
