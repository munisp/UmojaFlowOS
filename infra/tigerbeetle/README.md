# TigerBeetle cluster boundary

TigerBeetle is the authoritative store for a **confirmed double-entry transfer
fact** once it is deployed. PostgreSQL remains the authoritative control-plane
record for payment lifecycle, customer and counterparty records, compliance,
approval, evidence, reporting, and the projection of that confirmed fact.

The Go payment engine starts with a `DisabledClient` unless
`UMOJA_TIGERBEETLE_ENABLED=true`. An enabled process constructs the official Go
client exactly once at startup and exits instead of serving traffic if any
required setting is absent, malformed, insecure, or unreachable. It never
silently falls back to a disabled client after an operator requested activation.

## Provisioning sequence

1. Allocate a non-zero **cluster ID** and deploy a quorum-backed TigerBeetle
   cluster using TigerBeetle's supported replica-format and start workflow.
   Keep replica data, account identifiers, provider credentials, and settlement
   balances outside this repository.
2. Place the cluster behind a private authenticated encrypted TCP boundary,
   such as a service-mesh mTLS proxy. TigerBeetle's native protocol is TCP; the
   Go client does not invent native TLS support. Set `TLS_REQUIRED=true`.
3. Allocate immutable non-zero ledger numbers for **NGN**, **KES**, and **ZAR**.
   A currency may not share a ledger number with an unrelated currency.
4. Allocate non-zero account and transfer codes under the organisation's
   TigerBeetle code registry. Codes identify the accounting meaning of a record;
   they are not customer IDs or settlement status.
5. Provide the private cluster addresses and all values through deployment
   configuration using `tigerbeetle.env.template`. Do not put a credential,
   private key, provider token, or public endpoint in a source file.
6. Start the payment engine. It performs a bounded TCP reachability preflight
   before the official client is constructed. A failed preflight stops startup.
7. Run the activation regression against the provisioned cluster. Create the
   required history accounts with deterministic IDs, post an idempotent
   double-entry transfer, retrieve the confirmed fact through the approved
   operational process, and submit it with the PostgreSQL projection to the
   Rust reconciliation gateway. A mismatch is an incident, never an automatic
   lifecycle advancement.

## Runtime controls

| Setting | Required when enabled | Control |
| --- | --- | --- |
| `UMOJA_TIGERBEETLE_CLUSTER_ID` | Yes | Must be a non-zero unsigned integer. |
| `UMOJA_TIGERBEETLE_ADDRESSES` | Yes | Comma-separated private cluster addresses; each must pass a bounded TCP preflight. |
| `UMOJA_TIGERBEETLE_NGN_LEDGER`, `...KES...`, `...ZAR...` | Yes | Each must be a non-zero, distinct operating ledger allocated for that currency. |
| `UMOJA_TIGERBEETLE_ACCOUNT_CODE`, `...TRANSFER_CODE` | Yes | Non-zero TigerBeetle codes assigned by the accounting control owner. |
| `UMOJA_TIGERBEETLE_TLS_REQUIRED` | Yes | Must remain `true` outside an explicit development-only loopback cluster. |
| `UMOJA_TIGERBEETLE_ALLOW_INSECURE_LOOPBACK` | No | Defaults to `false`; only permits plaintext when every address is loopback. |

The payment engine accepts only TigerBeetle `created` or idempotent `exists`
results. An interrupted call is treated as indeterminate and must be retried
with exactly the same deterministic account or transfer ID. A Go adapter success
does **not** change a payment order to settled: the confirmed fact must agree
with its PostgreSQL projection under the independent Rust verifier first.
