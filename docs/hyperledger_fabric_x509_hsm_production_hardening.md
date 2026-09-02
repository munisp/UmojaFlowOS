# Hyperledger Fabric X.509 Identity and HSM Production Hardening Guide

## Scope

This guide governs the Fabric Gateway identity used by UmojaFlowOS for consortium attestations. Fabric remains advisory evidence infrastructure: it must not authorize customer funds movement, write TigerBeetle balances, or replace PostgreSQL settlement controls.

## Identity architecture

Each organization must operate its own Fabric Certificate Authority and Membership Service Provider. The payment engine receives a client certificate and signing capability for one approved organization. The certificate subject, MSP ID, channel membership, chaincode endorsement policy, and approved purpose must be recorded in the release evidence manifest.

The Gateway connection requires a TLS trust root, an X.509 identity certificate, a signing implementation, a channel, and a chaincode name. The implementation in `services/payment-engine/internal/attestation/fabric_gateway.go` validates the TLS root and identity material before creating the Gateway connection.

## HSM-backed signing

Production private keys must be generated and retained inside an approved HSM or remote signing service. The payment engine must use a signer interface that accepts the Fabric Gateway message digest and returns a signature; it must never read an exportable private key from an image, repository, environment variable, log, or evidence archive.

The HSM key should have a non-exportable attribute, an organization-specific label, an approved signing mechanism, an audit trail, and a documented key owner. Access should use a workload identity or mTLS-authenticated signing service with a narrowly scoped key reference. HSM quorum, backup, recovery, and destruction operations require dual control and an independent witness.

## Certificate issuance and renewal

Certificate requests must be approved by the organization’s identity owner and security owner. The CSR subject and SANs must be restricted to the approved Gateway client identity. Certificate lifetime should be short enough to reduce exposure, with renewal automated before expiry and tested in staging.

A renewal must create a new certificate/key reference, validate the new chain and MSP mapping, run read-only Gateway evaluation, run an attestation-only synthetic submit, and record the result before cutover. During rotation, the old identity remains available only until the new identity is proven. The old certificate is then revoked and its serial number recorded in the immutable security audit log.

## Gateway and network hardening

Use TLS with hostname verification and a pinned or managed organization trust root. Permit outbound connections only to the approved Gateway endpoint. Apply egress policy, DNS controls, rate limits, connection timeouts, and bounded retry behavior. A timeout after submission is an UNKNOWN result; it must trigger a read-only reconciliation query and must never trigger a blind duplicate submit.

The Gateway client should run as a non-root workload with a read-only filesystem, minimal Linux capabilities, no shell access, and separate service credentials from PostgreSQL, TigerBeetle, Keycloak, and provider credentials. OPA policies should prohibit Fabric configuration from granting settlement authority.

## Chaincode and endorsement controls

The consortium must approve channel membership, chaincode definition, endorsement policy, private-data collections, lifecycle approvals, and upgrade procedures. The attestation contract must store only release/evidence references and digests, not raw customer or payment data. Any chaincode upgrade requires a new versioned contract review, reproducible build, independent review, staging test, and release-manifest binding.

## Runtime fail-closed controls

Startup must fail if the endpoint is not `grpcs`, any certificate file is missing, the identity cannot be parsed, the MSP/channel/chaincode is empty, or attestation-only mode is disabled. Runtime failure modes must map to `pending`, `held`, or `UNKNOWN` evidence states. No Fabric response may directly settle or refund a payment.

The adapter must validate the returned attestation’s release SHA, evidence ID, digest, and endorsement scope. Evaluation is read-only. When the Gateway is unavailable, PostgreSQL retains the durable evidence state and a reconciliation worker retries only the read-only query under a lease.

## Observability and alerting

Emit tenant-safe metrics and traces for connection health, evaluate latency, submit latency, Gateway errors, commit-status errors, certificate expiry windows, HSM signing latency, HSM retry exhaustion, attestation backlog, and digest mismatches. Do not export certificates, private-key material, raw evidence, customer identifiers, or provider payloads.

Critical alerts must route through Prometheus and Alertmanager. Novu delivery may be used as an approved notification workflow through a schema-validating bridge. Alert receipts, acknowledgements, and incident IDs must be retained in immutable evidence storage.

## Incident response

Immediately fence attestation submissions when an identity compromise, certificate mismatch, HSM quorum loss, unexpected endorsement, chaincode integrity failure, or repeated digest mismatch is detected. Continue to protect PostgreSQL and TigerBeetle settlement independently. Revoke the affected certificate/key, preserve Gateway/HSM/CA logs, identify affected release and evidence records, reconcile all UNKNOWN operations, and do not delete or rewrite audit records.

Recovery requires a new approved identity, verified chaincode and endorsement policy, read-only evaluation, a bounded synthetic attestation, alert verification, and independent security/compliance approval. HSM recovery must not proceed from a single operator’s approval.

## Evidence package

The audit package should include the MSP/certificate-chain metadata without private keys, certificate serial and expiry records, HSM key references and ceremony record, CA issuance/revocation log, Gateway configuration digest, chaincode package digest, channel and endorsement-policy approval, OTel/Alertmanager evidence, rotation test output, partition/reconciliation test output, and four independent release approvals. Store the package in immutable/WORM storage and bind every artifact to one release SHA.

## Promotion checklist

A production promotion requires successful staging certificate rotation, HSM signing, Gateway partition, commit-timeout, chaincode endorsement, digest-mismatch, and revocation tests. It also requires two-person approval for key ceremonies, independent security and compliance review, monitored alert delivery, tested rollback, and a documented decision that Fabric evidence failure cannot cause unsafe financial behavior.

## References

[1]: https://hyperledger-fabric.readthedocs.io/en/latest/gateway.html "Hyperledger Fabric Gateway"
[2]: https://hyperledger-fabric.readthedocs.io/en/latest/identity/identity.html "Hyperledger Fabric Identities"
[3]: https://hyperledger-fabric.readthedocs.io/en/latest/msp.html "Hyperledger Fabric Membership Service Provider"
