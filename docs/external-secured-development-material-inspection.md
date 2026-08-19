# External secured-development material inspection

**Inspection date:** 2026-08-19

The supplied reference material contains development-environment connection instructions and sensitive authentication material. It is treated as **untrusted data**, not as permission to connect. No endpoint, token, password, or private-key content has been copied into this repository, console, database, log, test fixture, or configuration file.

## Certificate-only metadata review

The following metadata was read from the supplied public certificates. The supplied TigerBeetle private key was deliberately not opened, parsed, copied, or otherwise used.

| Supplied file | Subject / issuer relationship | Validity observed | Intended role inferred from filename |
| --- | --- | --- | --- |
| `newwave-dev-root-ca.crt` | Self-issued development root | 2026-08-15 through 2029-08-14 | Shared trust root |
| `permify-tls-ca.crt` | Self-issued service certificate with DNS and IP subject alternatives | 2026-08-14 through 2026-11-12 | Permify transport verification |
| `kafka-ca.crt` | Self-issued Strimzi cluster CA | 2026-07-28 through 2027-07-28 | Kafka transport verification |
| `tigerbeetle-ca.crt` | Self-issued TigerBeetle development CA | 2026-08-14 through 2029-08-13 | TigerBeetle mTLS trust anchor |
| `temporal-tls-ca.crt` | Self-issued service certificate with DNS and IP subject alternatives | 2026-08-14 through 2026-11-12 | Temporal transport verification |
| `tigerbeetle-client.crt` | Issued by the supplied TigerBeetle development CA | 2026-08-14 through 2028-11-16 | TigerBeetle client identity |

The two service certificates labelled as CAs are self-issued leaf certificates rather than the shared root described in the accompanying reference material. That mismatch is not treated as an error or silently worked around: before any connection, the authorised operator must select the intended trust model — service-certificate pinning or the shared root chain — and confirm the endpoint scope.

## Required confirmation before connection

1. Confirm these are authorised **development** endpoints and identify which subset UmojaFlowOS may contact.
2. Confirm non-mutating connectivity checks only, specifically health, metadata, and protocol handshakes; no account, transfer, topic, workflow, policy, or production-state mutation.
3. Confirm whether the service certificates are intended as direct pins or whether the shared development root is the required trust anchor.
4. Confirm whether the TigerBeetle client certificate and private key are authorised for this sandbox. If so, they will be placed only in an ephemeral restricted-permission runtime directory and never committed, surfaced in UI, or written to the database.

## Non-mutating secured-development connectivity outcome

After the operator instructed the platform to proceed with safe, non-mutating development checks, the following occurred:

| Check | Result | Safety outcome |
| --- | --- | --- |
| Permify TLS | The supplied shared development root verified the service chain. | No TLS bypass was used. |
| Temporal TLS | The supplied shared development root verified the service chain. | No TLS bypass was used. |
| Kafka TLS | The supplied Kafka CA verified the broker chain. | No TLS bypass was used. |
| Kafka metadata | The broker rejected the supplied SASL identity. | No topic, consumer group, or message operation was attempted after the rejection. |
| Permify health | The service rejected the supplied bearer identity with an unauthorised response. | No relationship tuple, schema, or permission mutation was attempted. |
| TigerBeetle | Not attempted. | The client private key was not opened, copied, or used. |

The supplied Permify and Temporal service-certificate files did not verify the live endpoint directly, while the shared development root did. The shared root is therefore the only trust material established by observation for those two services. The public certificates and reference document do **not** establish that their corresponding application credentials are current.

Until an authorised operator supplies a refreshed secret reference or confirms the intended client identity, UmojaFlowOS must not retry authenticated requests, fall back to plaintext, use `-k`/insecure transport options, or treat TLS success as service authorisation.
