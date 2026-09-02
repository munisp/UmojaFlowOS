# Primary-source notes: Hyperledger Fabric and TigerBeetle

- Hyperledger Fabric contract APIs: https://hyperledger-fabric.readthedocs.io/en/latest/sdk_chaincode.html
  - Fabric provides contract APIs for Go, Node.js, and Java, and application APIs including Fabric Gateway.
- Hyperledger Fabric Gateway: https://hyperledger-fabric.readthedocs.io/en/latest/gateway.html
  - Fabric Gateway manages evaluate, endorse, submit, commit-status, and chaincode-event flows. It uses endorsement policies and discovery, and supports Go, Node, and Java client APIs.
- Hyperledger Fabric ordering service: https://hyperledger-fabric.readthedocs.io/en/latest/orderer/ordering_service.html
  - Fabric uses deterministic ordering/finality and organization/channel access control; the documentation describes Raft and BFT ordering implementations.
- Hyperledger Fabric private data: https://hyperledger-fabric.readthedocs.io/en/latest/private-data/private-data.html
  - Private data collections distribute private data only to authorized peers while committing hashes to the shared channel ledger.
- Fabric Go Contract API: https://github.com/hyperledger/fabric-contract-api-go
  - Go contract API package is for chaincode running on Fabric v2.1 or later and is Apache-2.0 licensed.
- TigerBeetle documentation: https://docs.tigerbeetle.com/single-page/
  - TigerBeetle is documented as a financial-accounting database for double-entry bookkeeping and high-throughput OLTP, and it can be operated as a replicated cluster.

Use: These sources support keeping TigerBeetle as the internal accounting ledger and using Fabric, if needed, as an optional consortium-attestation/shared-proof layer rather than a second independent settlement authority.
