# Mojaloop provider boundary

The Go payment engine has a typed Mojaloop instruction contract and a disabled client that rejects every transfer submission. Configure a real client only after the licensed provider, scheme endpoint, mTLS client certificate, OAuth or signature mechanism, participant identifiers, and corridor-specific operational approvals are available.

The adapter does not bypass payment-policy, risk/compliance, idempotency, TigerBeetle, or human-review controls.
