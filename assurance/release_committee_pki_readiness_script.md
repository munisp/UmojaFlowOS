# Release Committee Presentation Script
## PKI Authorization and Canary Promotion Readiness

**Audience:** Release committee and four approval owners
**Decision scope:** Code-only readiness of the release-promotion and PKI authorization controls

## Slide 1 — Executive decision

**On-slide:** **84/100 code-only readiness; staging validation candidate; production remains NO-GO.**

**Speaker script:**

The code under review covers release authorization, signed-CRL and OCSP validation, canary promotion, and automatic rollback. Its code-only readiness score is **84 out of 100**. This supports controlled staging validation but does not support final production approval because live cluster evidence and independent regulatory approvals remain outstanding.

## Slide 2 — Evidence summary

| Evidence | Result |
|---|---:|
| Role-sidecar tests | 33 passed, 0 failed |
| Statement coverage | **91%** |
| Branch coverage | 76% |
| Python compilation | Passed |
| Bash syntax checks | Passed |
| Kind/Istio runtime | Not completed |

**Speaker script:**

The expanded suite now contains 33 tests and exits successfully. It covers signed CRL parsing, issuer and signature failures, CRL freshness, serial revocation, malformed X.509 input, OCSP transport failures, malformed and unsuccessful responses, OCSP GOOD responses, stale responses, manifest structure, sidecar binding, and CLI behavior. Statement coverage is above the requested 90 percent threshold. Branch coverage remains 76 percent and should continue to improve for security-sensitive paths.

## Slide 3 — Four-role authorization model

**On-slide:**

```text
release_manager
security_owner
compliance_owner
operations_owner
```

**Speaker script:**

Promotion requires exactly four distinct approval roles. Each role sidecar is bound to the manifest subject, the raw Ed25519 public-key SHA-256 digest, the release SHA, and the externally managed PKI authorization record. Missing, duplicated, unauthorized, expired, inactive, revoked, or mismatched role data causes a fail-closed result.

## Slide 4 — CRL and OCSP controls

**On-slide:**

```text
signed CRL → issuer/signature/freshness validation → serial revocation check
OCSP URL → HTTPS DER request → GOOD status → serial match → freshness check
```

**Speaker script:**

The signed-CRL path verifies the CRL’s issuer and cryptographic signature, checks `last_update` and `next_update`, and rejects role certificate serials listed as revoked. Production invokes the verifier with `--require-revocation-evidence`, which additionally requires certificate serials and OCSP evidence for every role. OCSP failures, including timeout, TLS failure, malformed response, non-success responder status, revoked or unknown status, mismatched serial, or stale response, block promotion.

## Slide 5 — Promotion and rollback

**On-slide paths:**

```text
scripts/infra/promote_verified_release.sh
scripts/infra/run_kind_canary_promotion_integration.sh
deploy/helm/umoja-payment-engine/templates/service.yaml
deploy/helm/umoja-payment-engine/templates/virtualservice.yaml
```

**Speaker script:**

The promotion flow verifies immutable release evidence and PKI status before installing the canary. It waits for readiness, shifts controlled traffic through the existing Istio VirtualService, and executes an operator-reviewed canary probe. Only after success does it install the identical digest as stable and shift 100 percent of traffic. Any failed command restores stable to 100 percent, canary to zero percent, and removes the canary release. Rollback never opens the settlement fence.

## Slide 6 — Runtime verification result

**On-slide:**

```text
Kind: installed
kubectl: installed
Helm: installed
Docker daemon: started but Kind cluster creation failed
Failure: kernel lacks iptables raw table support
Runtime exit code: 1
```

**Speaker script:**

The sandbox bootstrap installed Kind 0.25.0, kubectl 1.31.4, and Helm 3.16.4. Docker was installed and the daemon reached API-listening state. The full harness then attempted to create the Kind cluster but failed while configuring the Docker network because the sandbox kernel does not provide the required iptables raw table support. This is a runtime-environment blocker, not a passing integration result. The generated runtime output and status files must be retained as failed prerequisite evidence, not represented as canary success.

## Slide 7 — Committee decision

**Recommendation:** **Approve staging rehearsal only; do not approve production promotion.**

**Closure criteria:**

1. Run the harness on a host with a supported Docker/container runtime and required iptables/kernel capabilities.
2. Capture successful stable routing, canary weighting, probe, rollback, and VirtualService evidence.
3. Validate the real external PKI directory, signed CRL, and OCSP responder for all four roles.
4. Complete independent review of the evidence manifest and four-role signatures.
5. Obtain E-01–E-09 and staging/production approvals.

**Speaker script:**

The implementation is materially stronger and the requested statement-coverage target has been exceeded. Nevertheless, the absence of a successful live Kind/Istio or authorized staging run means the production evidence gate is not satisfied. The committee should authorize the next staging validation activity while preserving the current **NO-GO** production status.

## Closing statement

The correct release decision is: **code-only readiness 84/100; controlled staging candidate; production promotion blocked pending live runtime evidence and independent regulatory approval.**
