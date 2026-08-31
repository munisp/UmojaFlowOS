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

## Critical alert: step-by-step triage

### 1. Acknowledge and establish control

The on-call incident commander acknowledges `UmojaMojaloopSignerRetryExhausted` and records the alert fingerprint, first-seen timestamp, affected environment, release SHA, and current payment-engine node set. The commander assigns separate incident, communications, and evidence custodians. No person may both approve a signer-key change and execute that change.

### 2. Confirm the signal

Check Prometheus for `increase(umoja_signer_retry_exhausted_total[15m])`, `increase(umoja_signer_retries_total[15m])`, `increase(umoja_signer_attempts_total[15m])`, and `increase(umoja_signer_non_retryable_errors_total[15m])`. Correlate timestamps with payment-engine logs using the request correlation ID. Verify the alert is not caused by a stale series, counter reset, or test environment label.

### 3. Contain payment execution

Confirm `MOJALOOP_FSPIOP_ENABLED` and `MOJALOOP_FSPIOP_EXECUTION_ENABLED` are in the approved fail-closed state. If execution remains enabled, use the controlled feature gate to stop new Mojaloop submissions. Do not replay requests, increase `MOJALOOP_FSPIOP_SIGNER_MAX_ATTEMPTS`, or bypass the signer. Existing UNKNOWN provider outcomes remain in reconciliation and must not be sent to another rail without independent safe-non-submission evidence.

### 4. Separate failure classes

Inspect signer responses and classify the event as transient timeout/latency, HSM quorum loss, certificate or mTLS failure, authorization failure, invalid key reference, audience mismatch, request binding failure, or service saturation. Critical alerts require the incident commander to assume the worst class until evidence proves otherwise.

### 5. Check the signer service and HSM

Check signer health, HSM quorum, key availability, certificate validity, clock synchronization, connection-pool saturation, and network reachability from every payment-engine node. Compare node-specific retry counters and latency. Do not extract private key material or copy HSM secrets into logs, shells, tickets, or chat.

### 6. Preserve evidence

Capture the release SHA, configuration checksum, alert JSON, Prometheus query results, signer service health response, HSM audit event ID, certificate serial and expiry, retry-policy values, node inventory, and a sanitized sample correlation ID. Store evidence in the immutable audit location with the incident fingerprint and hash manifest.

### 7. Apply a controlled correction

A correction requires two authorized operators. One operator prepares the change; the second independently verifies the target key reference, signer audience, request method/URI binding, body digest policy, certificate chain, and rollback plan. Changes are first applied to staging and exercised with a synthetic signing canary. Production changes require an approved change record and an immutable audit entry.

### 8. Verify recovery

Run two consecutive healthy signing probes per production node. Confirm zero new retry exhaustion, stable signer latency, no non-retryable burst, and successful FSPIOP request-signature verification. Confirm that rejected submissions remain rejected and that no provider request was emitted during the outage unless separately authorized.

### 9. Re-enable gradually

Re-enable the Mojaloop execution gate through the approved deployment path, beginning with one canary node if the deployment topology supports it. Observe signer counters, payment outcomes, UNKNOWN queue age, provider lookup outcomes, and database pool behavior for the defined observation window. Stop immediately if retry pressure recurs.

### 10. Close and review

The incident commander closes the alert only after the evidence custodian confirms the evidence manifest and the compliance owner confirms no unauthorized settlement or duplicate business effect. Complete a post-incident review covering detection time, containment time, signer availability, retries, UNKNOWN outcomes, customer impact, control effectiveness, and corrective actions with owners and due dates.

## Escalation matrix

| Condition | Escalation |
|---|---|
| One node exhausts retries and execution is contained | Payment-engine on-call and signer-service owner |
| Two or more nodes exhaust retries within fifteen minutes | Incident commander, security, SRE, and compliance |
| HSM quorum loss or key compromise suspected | Security lead, HSM custodian, compliance officer, and executive incident sponsor |
| Any possible duplicate provider effect or settlement discrepancy | Freeze affected corridor, open financial-reconciliation incident, and notify compliance immediately |
