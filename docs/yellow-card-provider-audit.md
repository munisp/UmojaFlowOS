# Yellow Card stablecoin-provider audit

This assessment records only the public provider contract and UmojaFlowOS activation boundary. It stores **no** provider credential, endpoint configuration, partner record, customer data, wallet address, or transaction payload.

## Official public contract reviewed

Yellow Card documents an HMAC request scheme: requests include an ISO-8601 `X-YC-Timestamp` and an `Authorization` value in the `YcHmacV1` scheme, derived from the timestamp, request path, uppercase method, and a base64 SHA-256 body digest for write requests. Production also requires provider-side static-IP allowlisting. Its public RFQ reference describes a `POST /rfq` request with source/destination currency and type, amount, and an idempotency key; its public webhook guidance documents a body HMAC in `X-YC-Signature` and v2 lifecycle event names such as `SEND.*`, `RECEIVE.*`, `CRYPTO_SEND.*`, `CRYPTO_RECEIVE.*`, and `CONVERT.*`. [1][2][3][4]

| Source | URL | Reviewed |
| --- | --- | --- |
| Documentation index | <https://docs.yellowcard.engineering/llms.txt> | 2026-08-19 |
| Authentication | <https://docs.yellowcard.engineering/docs/authentication-api.md> | 2026-08-19 |
| RFQ reference | <https://docs.yellowcard.engineering/reference/create-rfq.md> | 2026-08-19 |
| Webhooks | <https://docs.yellowcard.engineering/docs/webhooks-api.md> | 2026-08-19 |
| Security guide | <https://docs.yellowcard.engineering/docs/integration-security-guide.md> | 2026-08-19 |

## UmojaFlowOS position

UmojaFlowOS supports **USDC and USDT only** in its stablecoin exposure and evidence models. It already has a provider-neutral activation boundary: the counterparty must have verified licence evidence; a documented integration must reference a deployment secret; and only a successful configured health check can make the connection active. A generic connection is therefore not a Yellow Card execution integration.

The additional work now tracked in the implementation ledger is a provider-specific adapter that will:

1. Require a named deployment-secret reference for API key and HMAC signing material, never browser input or a database secret field.
2. Enforce HTTPS and no embedded URL credentials, with a loopback exemption only for local protocol regression.
3. Limit requests to USDC/USDT paired with NGN, KES, or ZAR; require a caller-supplied idempotency key; and model an RFQ response as an **offer** rather than an accepted conversion or payout.
4. Verify webhook HMAC before accepting a state update; store only redacted event metadata; and require canonical payment/provider evidence before any lifecycle conclusion.
5. Remain disabled until the authorised provider counterparty, production allowlisting, secret references, and tested sandbox endpoint are supplied.

> A provider response, RFQ, rate, wallet state, or webhook does not by itself complete a payment, prove reconciliation, approve a customer, or submit a regulatory return.

## Lakehouse relationship

Stablecoin positions, peg observations, and provider lifecycle events are analytics projections only. The governed lakehouse rejects account, wallet, customer, document, credential, and raw-location fields. PostgreSQL retains the operational workflow and compliance record; TigerBeetle retains a confirmed activated double-entry fact; the lakehouse stores immutable redacted evidence suitable for approved analytics and model features.

## References

[1] [Yellow Card documentation index](https://docs.yellowcard.engineering/llms.txt)
[2] [Yellow Card authentication](https://docs.yellowcard.engineering/docs/authentication-api.md)
[3] [Yellow Card RFQ reference](https://docs.yellowcard.engineering/reference/create-rfq.md)
[4] [Yellow Card webhook guidance](https://docs.yellowcard.engineering/docs/webhooks-api.md)
