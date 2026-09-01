# Release Manifest Signature Verification: Static Side-Channel Audit

## Scope

This review covers `scripts/infra/verify_release_manifest_signatures.py`, `scripts/infra/verify_production_release_evidence.py`, and `services/payment-engine/internal/attestation/release_gate.go`. The audit focuses on signature comparison, manifest digest binding, release-SHA binding, approval metadata, and error-path timing.

## Findings

| Area | Result | Rationale |
|---|---|---|
| Ed25519 verification | Pass | Python uses `cryptography` `Ed25519PublicKey.verify`; Go uses the standard-library `ed25519.Verify`. Neither implementation compares signature bytes manually. |
| Manifest digest binding | Hardened | Python uses `hmac.compare_digest` for fixed-format digest text. Go uses `subtle.ConstantTimeCompare` after equal-length validation. |
| Release-SHA binding | Hardened | Fixed-length SHA/Git bindings use constant-time helpers in both implementations. |
| Artifact digest binding | Hardened | Go compares the expected and observed SHA-256 values through the constant-time helper. |
| Approval roles and subjects | Acceptable | These are public release metadata, not secret material. Early exits can reveal which public role or field failed, but do not disclose private keys or signature contents. |
| Schema and path validation | Acceptable | Validation intentionally fails early on malformed public input. This is required for fail-closed behavior and is not a secret-dependent branch. |
| Signature sidecars | Pass | All four required role sidecars are loaded and cryptographically verified independently. |
| Error messages | Acceptable with caution | CI/operator errors identify the failing public role. Logs must not include private keys, access tokens, or raw credentials. |

## Constant-time hardening applied

The Python verifier now uses `hmac.compare_digest` for expected release SHA, approval release SHA, sidecar release SHA, and sidecar manifest digest. The Go gate now uses `crypto/subtle.ConstantTimeCompare` for release SHA, payload digest, artifact digest, approval release SHA, sidecar release SHA, and sidecar manifest digest.

These comparisons are all fixed-format values: 40-character lowercase Git SHA values or 64-character lowercase SHA-256 values. Length checks occur before constant-time comparison and therefore do not create a meaningful secret-length channel because the accepted formats have fixed lengths and are public schema constraints.

## Residual considerations

The verifier still uses ordinary equality for role names, subjects, algorithms, environment names, bucket names, paths, and approval timestamps. These values are public manifest metadata and are not cryptographic secrets. Their early-exit behavior can reveal which malformed public field was encountered, which is acceptable for a CI release gate.

The code parses and validates one role at a time, so a caller who can precisely measure process runtime may infer which public sidecar failed first. This does not reveal the Ed25519 private key or allow signature forgery. If uniform error timing is required for a hostile remote oracle, the implementation should validate all four sidecars and aggregate failures before returning; that is not necessary for the intended offline/CI release-gate threat model.

Filesystem existence, JSON parsing, schema validation, and artifact reads necessarily have data-dependent I/O and parsing times. These operations involve release-bundle metadata and local evidence files, not secret key material. Private keys are never loaded by the verifier.

## Test evidence

The valid four-role fixture passed, and a tampered signature was rejected. Go manifest-gate tests passed with the invalid-WORM bucket case, valid signature case, and race detection. Static source review found no manual byte-by-byte signature comparison, no logging of private key material, and no use of ordinary equality for the fixed-format cryptographic bindings after hardening.

## Decision

**Status: PASS with documented residual metadata-timing exposure.** The signature verification boundary does not expose a practical secret-dependent comparison vulnerability in the reviewed code. The cryptographic libraries perform the Ed25519 verification; fixed-format digest and release bindings now use constant-time comparison helpers. The remaining early exits concern public release metadata and fail-closed input validation.
