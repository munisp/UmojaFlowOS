# Mojaloop Signer Operations Runbook

## Scope

This runbook covers delegated HSM or signing-service failures for the Mojaloop FSPIOP payment rail. It applies to `payment-engine` alerts with `component=mojaloop-signer`.

## Immediate safety posture

Keep Mojaloop execution fail-closed while a critical signer alert is firing. Do not bypass the signer, increase the retry budget in production, replay a timed-out provider write, or authorize settlement based only on a provider timeout or status lookup failure.

## Retry exhaustion

For `UmojaMojaloopSignerRetryExhausted`, acknowledge the PagerDuty incident, confirm the affected environment and release SHA, inspect signer service health and HSM quorum, and verify that new Mojaloop submissions are being rejected before provider transmission. Review `umoja_signer_retry_exhausted_total`, signer latency, and recent key-reference or authorization changes. Restore only after a successful staging canary and two consecutive healthy production signing probes.

## Retry pressure

For `UmojaMojaloopSignerRetryPressure`, inspect HSM latency, signing-service saturation, connection-pool wait, and network error rates. Keep execution enabled only if the error budget and fail-closed controls remain healthy. Escalate to critical if retry exhaustion or non-retryable errors appear.

## Non-retryable signer burst

For `UmojaMojaloopSignerNonRetryableBurst`, treat the event as a configuration, authorization, key-reference, or request-validation incident. Do not retry blindly. Validate signer audience, key reference, request method/URI binding, body digest, certificate validity, and service-account permissions. Require dual control for any key or policy correction.

## Recovery evidence

Record the alert fingerprint, start and resolution times, release SHA, signer key reference, HSM audit ID, probe results, retry counter deltas, and operator approvals. Link the evidence to the immutable operational audit trail before resolving the incident.
