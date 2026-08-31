# Mojaloop HSM Signer Credential Injection Security Review

## Scope

This review covers `MOJALOOP_FSPIOP_SIGNER_*` retry configuration, `MOJALOOP_SIGNER_KEY_REFERENCE`, delegated signer endpoints, and the process boundary between payment-engine and the HSM or signing service.

## Current controls

The payment-engine signer interface receives a signer implementation rather than a private key. The retry wrapper exposes counters only and does not record payloads, signatures, key references, or raw signer errors. The Mojaloop runbook prohibits raw private keys in environment variables, files, and container images. Retry values are bounded at startup, and non-transient errors are not retried.

## Required secret-management controls

| Control | Required production behavior |
|---|---|
| Private-key custody | Private keys remain inside the HSM or delegated signing service. Payment-engine receives only a key reference. |
| Credential injection | Use a secret manager or short-lived mounted secret file. Do not pass private material through command-line arguments, image layers, GitHub logs, or plain ConfigMaps. |
| File permissions | Mounted signer credentials must be owned by the payment-engine UID, mode `0400`, and reside on an encrypted volume. |
| Process visibility | Prevent secrets from appearing in `/proc` arguments, debug dumps, panic output, metrics, traces, and support bundles. |
| Endpoint security | Require mTLS or an equivalent authenticated protected channel to the signer service. Validate the server certificate and expected audience. |
| Request binding | The signer service must bind method, URI, body digest, key reference, audience, and correlation ID to every signing request. |
| Rotation | Rotate credentials and certificates under dual control, canary the new reference, retain rollback evidence, and revoke the old credential only after successful verification. |
| Authorization | The payment-engine service account may request signatures only for approved Mojaloop operations and may not export key material or alter signer policy. |
| Audit | Record key-reference use, signer decision, policy version, operator identity, and HSM audit ID without recording secret material. |

## Findings

The retry configuration loader is bounded and fail-closed, but the reviewed code does not itself prove that environment variables came from a secret manager or that a mounted token file has the required ownership and mode. Those controls belong in deployment admission and startup validation. The key reference is safer than a private key, but it must still be treated as sensitive because it identifies a signing authority.

The current metrics design is safe if the exporter continues to expose counters only. Error messages must remain typed and sanitized; raw HSM responses must never be placed in alert annotations or logs.

## Production acceptance criteria

Production enablement requires a deployment test that demonstrates no private key exists in the payment-engine filesystem or environment, the signer connection uses authenticated transport, a key reference cannot be changed by the payment-engine runtime identity, credentials rotate without downtime, and a revoked reference produces a non-retryable failure with a critical alert. The test must also confirm that a transient signer outage exhausts the bounded retry budget without causing a duplicate provider submission.
