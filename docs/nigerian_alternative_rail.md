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

## Production requirements

Before enabling the rail for a Nigerian bank or PSP, the counterparty must be identified, licensed/contracted, and assessed through the repository’s banking-partner and payout-PSP evidence controls. The counterparty must document its actual authentication, idempotency, status, reversal, timeout, webhook, and settlement semantics. Those semantics must be tested in staging and mapped explicitly rather than relying on the generic status table.

The current implementation is production-oriented and provider-neutral, but it is not a bank-specific production connection until those counterparty artifacts, credentials, network controls, and staging evidence exist.
