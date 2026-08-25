# External references used for staging integration

1. TigerBeetle Go client documentation: https://docs.tigerbeetle.com/coding/clients/go/

Key facts used: import `github.com/tigerbeetle/tigerbeetle-go`; construct a client with `NewClient(clusterID, replicaAddresses)`; a single client is thread-safe and should be shared; `CreateAccounts` and `CreateTransfers` accept batches; `created` and `exists` are successful/idempotent result statuses; cluster ID and replica addresses are deployment-selected values.

2. TigerBeetle documentation: https://docs.tigerbeetle.com/single-page/

Key facts used: TigerBeetle provides double-entry account/transfer primitives; cluster ID is supplied to the client to validate the intended cluster; a multi-replica deployment is required for high availability; transfer IDs uniquely identify transfers and balances preserve debit/credit equality.
