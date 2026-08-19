# Edge security and scheme interoperability

The edge and interoperability integrations deliberately separate **transport acceptance** from **payment authority and finality**. A request may be authenticated at the gateway, accepted by an external scheme, or recorded as an asynchronous reference without being a completed transfer. The canonical PostgreSQL lifecycle controls and verified provider evidence remain the only way the console may represent execution or completion.

| Component | Implemented boundary | What activates it | What it must never imply |
|---|---|---|---|
| Apache APISIX | Declarative routes for the control plane and Go, Rust, and Python services, each guarded by the APISIX `openid-connect` plugin. | The `infra/apisix/apisix.env.template` is enabled only with a TLS endpoint, secret-managed APISIX admin key, and configured Keycloak discovery URL. | A gateway-validated bearer token is not an approval to execute a payment. The back-end role procedure still decides authority. |
| open-appsec | Attachment-plus-agent deployment contract in prevention mode. The APISIX edge configuration is validated together with the requirement that the gateway run in the official open-appsec attachment image or matching Linux/Kubernetes integration. | `infra/openappsec/openappsec.env.template` requires the attachment, prevention mode, a policy-bundle reference, and an optional centrally managed agent token reference. | A route plugin name is not an integration. The official design attaches open-appsec to APISIX ingress, where it can inspect and block traffic before the private upstream. |
| Mojaloop FSPIOP | Go client posts a signed FSPIOP v1.1 `POST /transfers` request with UUID correlation, source/destination headers, signature, amount, condition, and Interledger packet. | A licensed scheme participant supplies an HTTPS endpoint and a signing-boundary reference. The private signing key is never a client configuration value. | HTTP 202 means **accepted for asynchronous processing only**. It is not clearing, settlement, completion, or an instruction to advance a payment order. |

## APISIX and open-appsec guard

The repository uses [APISIX’s documented open-appsec deployment model](https://apisix.apache.org/blog/2024/10/22/apisix-integrates-with-open-appsec/): an APISIX attachment and an appsec agent run together, with traffic inspected at ingress. This is materially different from adding an imagined per-route WAF plugin. The configuration validator confirms the approved five route set and requires every route to have:

| Control | Required value |
|---|---|
| Bearer enforcement | `bearer_only: true` |
| Identity discovery | `${KEYCLOAK_OIDC_DISCOVERY_URL}` |
| Identity TLS verification | `ssl_verify: true` |
| Identity timeout | `3000` milliseconds |
| Gateway client and realm | `umojaflowos-gateway` / `umojaflowos` |
| Private upstream | a non-empty internal upstream node |

`scripts/infra/test_validate_edge_policy.py` is a negative control: deleting the OIDC plugin or turning off discovery TLS causes the quality gate to fail. The sandbox has neither Docker nor a supported APISIX/open-appsec runtime, so this is a deployment-ready declarative integration rather than a claim that a local gateway was started.

## Mojaloop request lifecycle

The adapter follows the [Mojaloop FSPIOP v1.1 API definition](https://docs.mojaloop.io/api/fspiop/v1.1/api-definition.html). FSPIOP is asynchronous and uses a client-created UUID to correlate callbacks. UmojaFlowOS therefore treats the request as follows:

1. A separate authorised quote and provider workflow produces the UUID, Interledger packet, condition, future expiry, payer, payee, and corridor-compatible amount.
2. The configured client verifies the Nigeria (NGN), Kenya (KES), or South Africa (ZAR) corridor/currency pair; rejects remote plaintext, embedded endpoint credentials, missing/empty signature, past expiry, self-directed transfers, and malformed identifiers; then creates a signed `POST /transfers` request.
3. Only HTTP `202 Accepted` returns the supplied UUID as an **accepted asynchronous reference**. Any other response, timeout, or network error is a refusal. The client never fabricates a settlement status.
4. A future authenticated callback, reconciled with the scheme and canonical lifecycle controls, is required before any order could become completed or failed. That callback handler is not activated without an authorised Mojaloop deployment.

The Go regression suite drives the exact client through a real local HTTP server and checks the FSPIOP request headers, signature delegation, payload, loopback development exemption, and refusal of HTTP 200. This confirms the client protocol while keeping actual scheme connectivity gated on a licensed counterparty.
