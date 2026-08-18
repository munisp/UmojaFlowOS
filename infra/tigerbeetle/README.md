# TigerBeetle cluster boundary

The payment engine validates a non-zero cluster ID, non-empty private addresses, and a TLS-required configuration before any future TigerBeetle client is created. The currently configured `DisabledClient` still rejects all account and transfer commands.

Deploy a quorum-backed TigerBeetle cluster separately, generate its replica data through its supported format workflow, and provide cluster ID, private addresses, and transport credentials through managed secrets. Do not place settlement balances, provider credentials, or live account identifiers in this repository.
