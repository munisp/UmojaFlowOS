# Alertmanager Fence Bridge and Ed25519 Key-Rotation Runbook

## Purpose and safety boundary

This runbook deploys the Alertmanager webhook bridge that converts critical OPA alerts into signed settlement-fence commands. The bridge may **activate** a fence automatically, but it must never automatically clear a fence from an alert resolution. Clearing requires an authenticated, separately authorized recovery command after policy, telemetry, ledger quorum, and reconciliation evidence have been reviewed.

The settlement fence is fail-closed. If the bridge is unavailable, the signing key is unavailable, signature validation fails, audit persistence fails, or the command is expired, the payment engine must retain the existing fence and must not create new authoritative ledger transfers.

## Components and trust boundaries

| Component | Responsibility | Required control |
|---|---|---|
| Prometheus | Evaluates OPA timeout, failure, retry-exhaustion, and telemetry alerts | Rule files checked with `promtool` |
| Alertmanager | Routes only critical `hold_settlement` OPA alerts | mTLS and bearer authentication to bridge |
| Fence bridge | Validates Alertmanager payload, creates canonical command, signs with Ed25519 | Non-root process, bounded body, replay protection, audit logging |
| Payment engine | Verifies the signed command and applies the fence | Public-key pinning and validity-window checks |
| Audit store | Stores command hash, source alerts, signer, action, and timestamps | Append-only/WORM retention |
| Operators | Approve key ceremonies and fence clearing | Dual control; no shared private keys |

## Required command contract

The bridge sends a command matching `infra/monitoring/fence-command.schema.json`:

```json
{
  "command_id": "cmd-20260902-001",
  "action": "FENCE",
  "reason": "OPA retry exhaustion",
  "environment": "production",
  "source_alerts": ["UmojaOPARetryExhaustion"],
  "issued_at": "2026-09-02T12:00:00Z",
  "expires_at": "2026-09-02T13:00:00Z",
  "nonce": "base64url-random-value-at-least-16-characters",
  "signer": "alertmanager-fence-bridge",
  "signature": "base64-ed25519-signature"
}
```

The canonical payload is serialized with the signature field empty before signing. The payment engine verifies the signature with its pinned Ed25519 public key, rejects expired or not-yet-valid commands, rejects malformed commands, and ignores replayed `command_id` values after the first audited application.

## Prerequisites

Before deployment, confirm that the following are available:

```bash
export REPO=/home/ubuntu/UmojaFlowOS-repo
export ENVIRONMENT=production
export BRIDGE_NAMESPACE=umoja-monitoring
export PAYMENT_NAMESPACE=umoja-payment
export IMAGE_DIGEST='sha256:<64-lowercase-hex-digest>'
```

The release must have passed the OPA tests, artifact verification, four-role Ed25519 release-manifest verification, immutable-image verification, and the production GO gate. Do not deploy this bridge as a substitute for those gates.

## Ed25519 key ceremony

Generate keys only on an approved hardened workstation or HSM-backed signing service. Do not generate or copy private keys into Git, container images, Helm values, ConfigMaps, or ordinary Kubernetes Secrets.

For an offline development ceremony only:

```bash
openssl genpkey -algorithm ED25519 -out bridge-ed25519-private.pem
openssl pkey -in bridge-ed25519-private.pem -pubout -out bridge-ed25519-public.pem
sha256sum bridge-ed25519-public.pem
```

For production, the preferred arrangement is an HSM or remote signer that exposes only a signing operation. If a file-backed key is temporarily approved, store it in an external secret manager and mount it through a short-lived, read-only secret volume. Restrict access to the bridge service account and the two-person key-custody group.

Record the following in the immutable key-ceremony record:

| Field | Requirement |
|---|---|
| Key ID | Globally unique, versioned identifier |
| Algorithm | Ed25519 |
| Public-key digest | SHA-256 digest of canonical public key bytes |
| Custodians | Two independently authenticated approvers |
| Created/activation time | UTC timestamp |
| Not-before/not-after | Explicit validity window |
| HSM slot or secret reference | No private key material in the record |
| Test signature | Verified by an independent operator |
| Revocation status | Active, retired, or revoked |

## Kubernetes secret and public-key configuration

The bridge private key should be supplied by an external secret operator. The payment engine needs only the public key:

```yaml
apiVersion: v1
kind: Secret
metadata:
  name: umoja-fence-bridge-public-key
  namespace: umoja-payment
type: Opaque
stringData:
  ed25519-public-key.b64: "<base64-encoded-32-byte-public-key>"
---
apiVersion: v1
kind: Secret
metadata:
  name: umoja-fence-bridge-auth
  namespace: umoja-monitoring
type: Opaque
stringData:
  bearer-token: "<short-lived-secret-from-external-secret-manager>"
```

Do not place the bridge private key in this manifest. The production deployment must use an external secret provider, HSM, or OIDC-authenticated signer.

## Alertmanager configuration

Merge `infra/monitoring/alertmanager-fence-bridge.yml` into the production Alertmanager configuration. The route must match all of the following:

```text
severity="critical"
action="hold_settlement"
alertname in the explicit OPA critical-alert allowlist
```

The configured critical alerts are:

```text
UmojaOPAEvaluationTimeouts
UmojaOPAEvaluationFailuresByClass
UmojaOPARetryExhaustion
UmojaOPAIntegrityTelemetryAbsent
```

Validate before reload:

```bash
promtool check config /etc/alertmanager/alertmanager.yml
amtool check-config /etc/alertmanager/alertmanager.yml
```

Reload only after the configuration passes validation and the bridge mTLS certificate, CA, endpoint, and bearer-token file are present.

## Bridge deployment controls

The bridge deployment must enforce:

```yaml
securityContext:
  runAsNonRoot: true
  readOnlyRootFilesystem: true
  allowPrivilegeEscalation: false
  capabilities:
    drop: ["ALL"]
resources:
  requests:
    cpu: 50m
    memory: 64Mi
  limits:
    cpu: 250m
    memory: 256Mi
```

The bridge must expose authenticated health endpoints separately from the command endpoint. Liveness must verify process health only. Readiness must verify signer availability, public-key configuration, audit-store connectivity, and clock validity. It must not report ready if it cannot produce an auditable command.

Network policy must allow ingress only from Alertmanager and egress only to the signer, audit store, and payment-engine fence endpoint. All external connections require TLS with certificate verification.

## Deployment sequence

1. Verify the release digest, manifest signatures, policy tests, and evidence GO gate.
2. Confirm the current payment engine fence state and record the current fence version.
3. Provision the public verification key to the payment engine and verify its SHA-256 digest out of band.
4. Provision the private signing capability to the bridge through the approved HSM or external secret mechanism.
5. Deploy the bridge with a canary replica and readiness checks enabled.
6. Send a non-production signed `FENCE` command to the staging payment engine and verify signature validation, audit persistence, and ledger-post rejection.
7. Send the same `command_id` again and verify idempotent replay handling with exactly one audit application.
8. Route a synthetic critical OPA alert through Alertmanager and verify that the bridge creates one signed command with the expected environment and source alert.
9. Confirm that a resolved alert does not generate an `OPEN` command.
10. Promote the bridge to production only after independent operations and compliance approval.

## Key rotation procedure

Use overlapping public-key trust during rotation. Never replace the old key before the new key is active and tested.

### Preparation

1. Generate or provision the new Ed25519 key in the HSM.
2. Record the new key ID, public-key digest, custodians, validity window, and ceremony evidence.
3. Verify a test signature independently.
4. Add the new public key to the payment engine’s trusted-key set with status `staged`.
5. Deploy the bridge configured to sign with the new key, while retaining the old key as accepted for verification.

### Activation

1. Issue a signed staging fence command with the new key.
2. Verify that the payment engine accepts it and that the audit record contains the new key ID or signer version.
3. Verify that old-key commands remain accepted only until the published retirement time.
4. Promote the new bridge signer after dual approval.
5. Monitor signature failures, command rejection, audit write failures, and OPA-related fence alerts for at least one full operational observation window.

### Retirement

1. Stop new commands from the old signer.
2. Confirm there are no in-flight commands signed by the old key that must still be processed.
3. Mark the old key retired in the immutable key registry.
4. Remove the old public key only after its validity window has ended and compliance has approved removal.
5. Preserve the retired public key and verification metadata for the full audit-retention period.

## Rollback and emergency response

If the new signer produces invalid signatures, the bridge cannot write audit records, or the payment engine rejects valid commands, stop the bridge rollout and retain the current fence. Roll back the bridge deployment to the last verified image and signer version, but do not automatically open settlement.

If the private signing key is suspected compromised:

1. Revoke the key in the key registry/HSM.
2. Fence settlement immediately through the independent emergency procedure.
3. Rotate to a newly approved key using dual control.
4. Reject all commands signed by the compromised key.
5. Reconcile command IDs, audit hashes, Alertmanager notifications, and payment-engine fence versions.
6. Preserve all evidence under WORM retention and open a security incident.

If the bridge is unavailable, Alertmanager may continue delivering alerts to the audit sink, but the payment engine must remain fenced or continue per-intent fail-closed handling. Operators must not bypass the signed-command gate with an unsigned HTTP request.

## Verification checklist

```bash
# Schema validation
jq empty "$REPO/infra/monitoring/fence-command.schema.json"

# Go tests
cd "$REPO/services/payment-engine"
export PATH="$REPO/.toolchain/go/bin:$PATH"
go test ./internal/reconciliation ./internal/observability -count=1 -race -v

# Prometheus rules
promtool check rules "$REPO/infra/monitoring/umoja-native-idem-alerts.yml"

# Alertmanager configuration
promtool check config /etc/alertmanager/alertmanager.yml
amtool check-config /etc/alertmanager/alertmanager.yml

# Kubernetes manifests
kubectl diff -f rendered-fence-bridge.yaml
kubectl apply --dry-run=server -f rendered-fence-bridge.yaml
```

Evidence must include the test log, coverage profile, rendered manifests, Prometheus and Alertmanager validation output, key-ceremony record, public-key digest comparison, synthetic alert delivery trace, fence command audit record, and rollback rehearsal result.

## Required production decision

Deployment is **NO-GO** if the bridge cannot produce a signed, auditable command; if the payment engine accepts an invalid, expired, replayed, or unsigned command; if Alertmanager routes unrelated alerts to the fence endpoint; if resolved alerts can automatically open settlement; or if the private key is not protected by approved custody controls.
