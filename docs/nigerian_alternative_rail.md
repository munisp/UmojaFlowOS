# Nigerian Alternative Payment Rail

`services/payment-engine/internal/provider/nigerian_bank_rail.go` implements the provider-neutral alternative rail used after Yellow Card only when the primary outcome is explicitly proven to have had no business effect.

## Contract

The adapter expects a configured HTTPS base URL and a deployment-managed bearer token. Its counterparty-neutral endpoints are:

| Operation | Path | Method | Write capability |
|---|---|---|---:|
| Submit transfer | `/v1/transfers` | `POST` | Yes |
| Lookup transfer | `/v1/transfers/{sequenceId}` | `GET` | No |

These are an UmojaFlowOS adapter contract, not a claim about any particular bank or PSP’s public API. A licensed Nigerian counterparty must provide an approved translation layer or implement the same contract before production activation.

## Required request fields

The canonical payload contains `sequenceId`, positive `amountMinor`, `currency=NGN`, a three-to-six digit `bankCode`, a ten-digit `accountNumber`, `accountName`, and an optional narration. `sequenceId` must equal the multirail intent idempotency key. The POST request carries both `Idempotency-Key` and `X-Umoja-Payload-SHA256` headers.

The adapter rejects malformed account data, non-NGN requests, changed sequence identifiers, missing provider references, plaintext non-loopback transport, and missing bearer credentials.

## Fail-closed response mapping

Accepted, created, queued, processing, pending, and in-progress states become provisional `Pending` results. Completed and settled states become `Settled`. Every other state becomes `Unknown`; no generic failure or unrecognized provider status is treated as proof of non-submission.

The coordinator remains the only component allowed to select this rail. The reconciliation worker cannot invoke it. A transport failure on this alternative rail is therefore unresolved and must be reconciled through its own provider lookup and evidence path.

## Production configuration

The payment-engine deployment must define the following variables. Defaults are intentionally fail-closed.

| Variable | Required value | Secret | Startup rule |
|---|---|---:|---|
| `NIGERIAN_RAIL_ENABLED` | `false` or `true` | No | Defaults to `false`; enabling requires all remaining fields. |
| `NIGERIAN_RAIL_EXECUTION_ENABLED` | `false` or `true` | No | Must remain `false` until counterparty and staging gates pass. |
| `NIGERIAN_RAIL_BASE_URL` | Absolute `https://` provider-contract URL | No | Required when execution is enabled; reject credentials in the URL and reject plaintext outside loopback development. |
| `NIGERIAN_RAIL_BEARER_TOKEN` | Secret-manager reference materialized at runtime | Yes | Required when execution is enabled; never use a source-control or image-baked value. |
| `NIGERIAN_RAIL_TIMEOUT` | Bounded duration, recommended `10s` maximum | No | Must parse as a positive bounded duration; timeout is always UNKNOWN, never safe non-submission. |
| `NIGERIAN_RAIL_CA_BUNDLE` | Optional trusted CA path for private PKI | No | Required when the counterparty certificate chain is not in the host trust store. |
| `NIGERIAN_RAIL_MAX_BODY_BYTES` | Positive bounded integer, recommended `262144` | No | Limits provider response memory use; oversized responses fail closed. |

A production deployment should inject the bearer token as a mounted secret file or through a secret-manager sidecar and expose only the file path to the process, for example `NIGERIAN_RAIL_BEARER_TOKEN_FILE=/run/secrets/nigerian-rail/bearer_token`. If the current constructor receives the token as a string, the composition layer must read the file once, trim only the trailing newline added by the secret mount, and avoid logging the value. The secret file should be owned by the payment-engine service account with mode `0400`, and the service account must have no permission to write or delete its own credential.

The token must not appear in environment dumps, structured logs, traces, panic reports, metrics labels, HTTP error strings, or support bundles. Rotation requires two-person approval, provisioning the replacement credential, a staging canary lookup, a rolling restart or hot reload that preserves the old credential until the new one is verified, and revocation of the old credential only after the canary succeeds. Failed canaries must leave execution disabled and retain the old verified credential.

## Startup validation

The application composition layer must validate configuration before registering the rail with the coordinator. The following combinations must fail startup rather than silently disabling a misconfigured production rail:

| Condition | Required result |
|---|---|
| `NIGERIAN_RAIL_EXECUTION_ENABLED=true` and `NIGERIAN_RAIL_BASE_URL` absent | Refuse startup. |
| Execution enabled and bearer token absent or unreadable | Refuse startup. |
| Execution enabled and base URL is non-HTTPS outside an explicitly declared loopback test profile | Refuse startup. |
| Execution enabled and timeout is absent, zero, negative, or above the deployment maximum | Refuse startup. |
| `NIGERIAN_RAIL_ENABLED=false` | Do not construct or register the rail; emit a redacted configuration-state metric only. |
| Execution enabled without an injected secondary rail or durable UNKNOWN store | Refuse startup; the coordinator must never operate in an unprotected direct-submit mode. |
| Production profile requests loopback HTTP | Refuse startup. |

The startup validator must run before the HTTP server reports readiness. Configuration errors must be written as redacted reason codes, not raw URLs, tokens, or payloads. Health checks must report the rail as unavailable until validation and dependency checks pass.

## Counterparty and production gates

Before enabling the rail for a Nigerian bank or PSP, the counterparty must be identified, licensed/contracted, and assessed through the repository’s banking-partner and payout-PSP evidence controls. The counterparty must document its actual authentication, idempotency, status, reversal, timeout, webhook, and settlement semantics. Those semantics must be tested in staging and mapped explicitly rather than relying on the generic status table.

The current implementation is production-oriented and provider-neutral, but it is not a bank-specific production connection until those counterparty artifacts, credentials, network controls, startup gates, and staging evidence exist.
