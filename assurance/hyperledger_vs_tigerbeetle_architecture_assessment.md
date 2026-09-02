# Hyperledger versus TigerBeetle Architecture Assessment

## Short answer

UmojaFlowOS is not using Hyperledger as its primary internal financial ledger because the platform’s immediate requirement is a high-throughput, low-latency, double-entry settlement system controlled by one operator, while Hyperledger is primarily a **multi-organization permissioned blockchain network** with endorsement, ordering, membership, channel, and peer-governance overhead.

That is an architectural choice, not a rejection of blockchain. Hyperledger could be valuable as an inter-institutional evidence or shared-settlement network, but adding it as the internal source of truth would introduce a second consensus and data-governance system that must be reconciled with TigerBeetle, PostgreSQL, providers, custody, and public-chain finality.

## What the current design optimizes

TigerBeetle is used for the internal financial-accounting core because the platform needs deterministic double-entry posting, idempotent transfer semantics, high write throughput, and strong operational control. The official TigerBeetle documentation describes it as a financial-transactions database for double-entry bookkeeping and explains that it is designed for write-heavy OLTP workloads and high contention. [1]

PostgreSQL remains the system of record for workflow, evidence, identity, policy, reconciliation, and operational metadata. It is not used as a substitute for the financial ledger.

## What Hyperledger would add

Hyperledger Fabric provides a permissioned network model where organizations have identities, peers endorse transactions, an ordering service orders transactions, and peers validate and commit them. Fabric documentation describes deterministic ordering/finality and organization-level access control for channels. [2]

Fabric private-data collections can keep selected data only among authorized organizations while committing hashes to the shared ledger. [3] This is useful when banks, PSPs, custodians, regulators, or other institutions must independently endorse or audit a shared record without exposing all commercial details to every participant.

## Why not use Hyperledger as the primary ledger today?

| Concern | TigerBeetle/PostgreSQL design | Hyperledger design implication |
|---|---|---|
| Ledger shape | Native double-entry financial transfer model | Requires chaincode/state modeling and careful accounting invariants. |
| Latency/throughput | Optimized for internal OLTP and hot-account contention | Endorsement, ordering, validation, gossip, and commit introduce more network hops. |
| Operational boundary | One platform controls the cluster and policies | Multiple organizations, MSPs, CAs, peers, orderers, channels, and governance policies must be operated. |
| Customer privacy | Sensitive data remains in controlled systems; hashes/evidence can be shared | Channels and private collections require careful membership and data-lifecycle management. |
| External providers | Provider-neutral adapters already return references/statuses | Hyperledger does not remove the need for bank, custody, issuer, or blockchain adapters. |
| Reconciliation | One internal financial ledger plus evidence and provider reconciliation | Adds another ledger requiring bidirectional reconciliation and dispute procedures. |
| Regulatory operations | CBN evidence package can expose controlled records and immutable hashes | A consortium governance model and node/operator responsibilities must also be approved. |
| Resilience | TigerBeetle quorum and payment-engine fencing are already designed | Fabric introduces orderer/peer/channel failure modes and membership operations. |

The decisive point is that a blockchain network does not automatically solve provider settlement, fiat payout, custody signing, sanctions screening, Travel Rule compliance, chain finality, or customer refunds. It changes the consensus and sharing model; it does not remove the business controls.

## Where Hyperledger could fit

A suitable future pattern is an **optional inter-institutional evidence or settlement-notary layer**:

```text
UmojaFlowOS internal ledger: authoritative customer accounting
        │
        ├── PostgreSQL evidence and workflow record
        ├── TigerBeetle double-entry posting
        └── Optional Hyperledger shared proof/consortium record
```

A Fabric channel or private-data collection could hold a hash-bound proof of a provider settlement, reconciliation result, or regulatory evidence package. The internal system would retain the sensitive details and use the Hyperledger record as a consortium-verifiable attestation. This would preserve tenant privacy while allowing approved institutions to verify that a record existed and was endorsed.

A Hyperledger integration should not be allowed to independently settle customer balances. It should be an append-only external attestation until governance, performance, privacy, and reconciliation are proven.

## Decision criteria for introducing Hyperledger

The platform should add Hyperledger only if at least two or more independent institutions require a shared ledger or endorsement process that cannot be achieved through signed evidence, WORM storage, or provider APIs. The consortium must agree on membership, identity, endorsement, privacy, retention, dispute resolution, legal responsibility, and data residency.

Before adoption, run a comparative staging benchmark that measures end-to-end latency, throughput, recovery, peer/orderer loss, privacy collection repair, chaincode upgrade, certificate rotation, and reconciliation against TigerBeetle. The benchmark must use real approved workload characteristics rather than synthetic claims about absolute performance.

## Recommendation

Keep TigerBeetle as the internal settlement ledger and PostgreSQL as the workflow/evidence store. Treat Hyperledger as an optional consortium integration for shared attestations or multi-party settlement records. Revisit a Fabric channel when banks, PSPs, custodians, or regulators require independent endorsement and shared verification as an explicit business requirement.

This preserves the platform’s open-source and cloud-agnostic posture without introducing unnecessary consensus duplication before the fiat, custody, blockchain-finality, AML, reconciliation, and staging evidence gates are closed.

## References

[1]: https://docs.tigerbeetle.com/single-page/ "TigerBeetle Documentation"
[2]: https://hyperledger-fabric.readthedocs.io/en/latest/orderer/ordering_service.html "Hyperledger Fabric: The Ordering Service"
[3]: https://hyperledger-fabric.readthedocs.io/en/latest/private-data/private-data.html "Hyperledger Fabric: Private Data"
