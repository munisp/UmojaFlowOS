# UmojaFlowOS Fabric Consortium Governance Agreement and Channel Configuration Policy

## Status and scope

This document is a production governance template for legal, compliance, security, and technical approval by participating organizations. It is not itself an authorization to operate a regulated payment service. Hyperledger Fabric is used for consortium attestation and shared evidence proofs; PostgreSQL remains the workflow/evidence store and TigerBeetle remains the internal double-entry accounting ledger.

## Parties and roles

The consortium consists of the platform operator, approved banking/PSP participants, custody or issuer participants, independent assurance participants, and any regulator-observer role approved by the relevant authority. Each party must be a separately controlled legal organization with a named MSP ID, certificate authority, security contact, compliance contact, and 24-hour incident contact.

The Consortium Board approves membership, channel policy, endorsement policy, chaincode lifecycle, privacy policy, risk appetite, material changes, suspension, and exit. No one organization may unilaterally change an endorsement rule, erase an attestation, add a member, or grant settlement authority through Fabric.

## Membership and identity governance

Each organization owns its CA and MSP material. Client, peer, orderer, and administrator identities must be separate. Administrator identities may manage consortium configuration but must not be used by the payment engine. The payment engine receives one least-privilege client identity limited to the attestation chaincode operations approved by the Board.

Certificates must contain an approved organization identity, role, and purpose. Private keys must be non-exportable where supported and protected by an HSM or approved remote signer. Certificate issuance, renewal, revocation, suspension, and recovery require two authorized people and an immutable audit record.

## Channel configuration policy

The production channel must have a unique approved name, a version-controlled genesis/configuration record, a defined Application capability, and a documented member list. Each peer must use TLS, authenticated gossip, state-database encryption, disk encryption, time synchronization, restricted egress, and monitored administrative access.

The channel stores attestation metadata only: release SHA, evidence ID, evidence digest, evidence URI/reference, endorsement scope, creator MSP, and timestamps. Raw customer data, payment amounts, account numbers, KYC documents, credentials, private keys, and provider payloads are prohibited from public channel state.

If a private value is required for a consortium decision, the parties must approve a private-data collection with explicit member access, dissemination policy, retention period, purge policy, hash-verification procedure, and legal basis. Fabric private-data collections distribute the private value to authorized peers while recording a hash on the shared channel ledger. [1]

## Endorsement and transaction policy

CreateAttestation must require endorsements from the organizations named in the approved endorsement scope. The policy must be versioned and tested for member loss, unavailable peer, invalid certificate, conflicting response, and policy upgrade. A successful Fabric transaction is proof of an endorsed attestation only. It is never a payment authorization, custody instruction, bank payout instruction, or TigerBeetle posting instruction.

The client must submit a canonical request containing release SHA, evidence ID, evidence SHA-256, evidence URI, and endorsement scope. All endorsers must observe the same digest. A digest mismatch, unexpected organization, invalid policy response, or commit-status timeout creates an evidence UNKNOWN state and a reconciliation task; it does not trigger a retry or settlement.

## Chaincode lifecycle and change control

The chaincode definition, package digest, initialization requirement, endorsement policy, collection configuration, and approval record must be version controlled. A lifecycle upgrade requires security review, compliance impact review, reproducible build, two-party approval from each required organization, staging execution, rollback plan, and independent release-manifest binding.

Emergency changes may reduce availability but must not weaken identity validation, evidence immutability, digest binding, or attestation-only boundaries. Every emergency change must be retrospectively reviewed by the Consortium Board.

## Availability, incident, and Byzantine response

A suspected compromised organization, split-brain view, certificate compromise, invalid endorsement, chaincode divergence, repeated commit timeout, or digest disagreement triggers channel write fencing for the affected attestation class. The platform must preserve PostgreSQL and TigerBeetle safety independently and hold unresolved evidence as UNKNOWN.

The Incident Commander may suspend a participant’s certificate or channel access only under the approved incident procedure. The Security Owner preserves CA, peer, orderer, Gateway, HSM, OTel, and Alertmanager records. Compliance determines regulatory notification, customer-impact assessment, retention, and legal-hold requirements.

Recovery requires quorum and membership verification, certificate review, chaincode/package digest review, read-only evaluate checks, a bounded synthetic attestation, alert verification, reconciliation, and independent approval. No operator may manually rewrite a committed attestation or delete audit evidence.

## Privacy, retention, and data protection

The consortium must approve data classification, lawful purpose, residency, retention, deletion/hold, access review, and breach-notification rules. Evidence URIs must resolve to controlled immutable storage; the Fabric ledger stores a digest and reference, not the raw regulated artifact.

A member’s removal must not destroy historical proof. Access to private collections and evidence storage must be reviewed periodically. All administrator and Gateway access must produce tenant-safe telemetry and immutable audit records.

## Monitoring and audit

Each organization must expose health and security telemetry for peer/orderer/Gateway connectivity, certificate expiry, endorsement failures, commit latency, digest mismatch, private-data dissemination, chaincode errors, and unauthorized access. Metrics flow to Prometheus and Alertmanager; traces flow through the OpenTelemetry Collector to the approved trace backend. Novu notifications may be used only through the approved schema-validating bridge.

Quarterly, the Consortium Board reviews membership, access, certificate inventory, endorsement policy, chaincode digest, incident records, alert delivery, DR tests, reconciliation results, and unresolved exceptions. Independent assurance reviews the release SHA and artifact manifest.

## Key custody and quorum

CA, peer, orderer, and Gateway signing keys must have named owners, HSM references, rotation dates, backup/recovery procedures, revocation procedures, and dual-control ceremonies. No private key may appear in source, an image, a CI log, an evidence bundle, or a support ticket. HSM quorum loss is a hard stop for identity-dependent writes.

## Dispute, suspension, and exit

A party may dispute an attestation by presenting the release SHA, evidence digest, transaction ID, endorsement records, and independent evidence object. Dispute does not permit ledger edits; it creates a governed review and, if required, a superseding attestation.

A participant may be suspended for compromise, regulatory loss, material breach, or repeated policy failure. Suspension must preserve historical proof and restrict new endorsements. Exit requires certificate revocation, access removal, private-data handling, evidence custody transfer, and confirmation that the channel remains above its approved operational quorum.

## Required production configuration approvals

The following artifacts must be approved before production channel creation: membership roster, MSP/CA trust roots, channel configuration, anchor peers, ordering service topology, endorsement policy, private-data collections, chaincode definition/package digest, Gateway TLS profile, HSM ceremony, monitoring and alert routes, backup/restore plan, incident contacts, and four-role release approval bound to one immutable SHA.

## References

[1]: https://hyperledger-fabric.readthedocs.io/en/latest/private-data/private-data.html "Hyperledger Fabric Private Data"
[2]: https://hyperledger-fabric.readthedocs.io/en/latest/gateway.html "Hyperledger Fabric Gateway"
[3]: https://hyperledger-fabric.readthedocs.io/en/latest/msp.html "Hyperledger Fabric Membership Service Provider"
