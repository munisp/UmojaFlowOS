# Mojaloop external sources used in payment-rail audits

## Sources

1. https://docs.mojaloop.io/reference-architecture-doc/boundedContexts/fspInteropApi/
   - Official Mojaloop Reference Architecture FSP Interoperability API bounded context.
   - Defines GET transfer lookup as GET `/transfers/{ID}`.
   - Describes transfer processing as asynchronous and includes transfer states such as prepared, reserved, committed, and aborted.

2. https://docs.mojaloop.io/api/fspiop/v1.1/api-definition.html
   - Official Mojaloop FSPIOP API v1.1 definition.
   - States that participant/common transfer IDs are UUIDs.
   - Describes asynchronous REST behavior, POST `/transfers`, GET `/transfers/{ID}`, and FSPIOP signing/security requirements.

3. https://interledger.org/developers/rfcs/interledger-protocol/
   - Official Interledger Protocol reference.
   - Used to distinguish ILPv4 Prepare packets from Fulfill packets and to require a 32-byte cryptographic execution condition.

## Audit interpretation

HTTP 404, 5xx, timeout, malformed status, transfer-ID mismatch, and unknown provider state are treated as inconclusive by UmojaFlowOS. They must not authorize automatic fallback. Only an explicit provider-confirmed non-submission state may enable secondary-rail selection.
