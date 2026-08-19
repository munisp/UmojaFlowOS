# Session state — middleware platform tier

## Completed in this session so far

- Credential rotation audit trail, service-health history charts, retryable form submissions, and stakeholder-language UI pass.
- Live Temporal and Permify integration completed earlier in this session.
- Live eventing chain now verified: Go native Kafka and Dapr publishers, Rust Dapr and Fluvio publishers, Python Dapr subscriber, and Redis atomic evidence ledger.

## Local runtime findings

- Redpanda, Dapr, Temporal, Permify, Redis, and Fluvio run locally for development verification.
- The sandbox does not provide Docker and has limited remaining memory, so OpenSearch, Keycloak, Mojaloop, APISIX/open-appsec, Spark/Sedona, and GeoLibre must remain activation-gated unless a compatible lightweight process can be proven to run.
- Middleware requiring long-lived background processes must run in deployment as managed persistent services; this sandbox run is verification only and cannot remain an always-on production environment.

## Current implementation phase

Integrate the remaining data and platform tier: TigerBeetle, OpenSearch, Keycloak, lakehouse, Apache Sedona, and GeoLibre. PostgreSQL remains the sole canonical business database; new systems can hold projections, durable workflow evidence, or independently verified ledger records but cannot become a silent substitute for the control plane.

TigerBeetle client verification: the official documentation confirms the maintained Go module is `github.com/tigerbeetle/tigerbeetle-go`, while the official Rust client is supplied from the TigerBeetle repository source rather than a maintained crates.io package. The live adapter will therefore be implemented in Go at the payment-engine boundary, with the Rust ledger gateway continuing to independently validate posting balance and PostgreSQL projection agreement instead of duplicating an unofficial native binding.

Analytics-layer finding: the Python service already exposes a fail-closed bronze manifest and a privacy-preserving jurisdiction aggregation contract, but it has no durable object-store writer, Apache Sedona job client, or GeoLibre publication adapter. The next implementation must add these as explicit configuration-gated clients without accepting raw coordinates, document bytes, account numbers, or customer names.

GeoLibre source verification (2026-08-19): [the official GeoLibre repository](https://github.com/opengeos/GeoLibre) describes a browser-first, privacy-preserving GIS platform built on MapLibre GL JS, DuckDB-WASM Spatial, and deck.gl, with local client-side processing. [Its getting-started guide](https://geolibre.app/getting-started/) documents project/data URL loading and a Docker-based self-hosting option, but it does not specify a backend ingestion API suitable for creating sensitive organisational projects. Therefore UmojaFlowOS will produce only approved aggregate GeoJSON/GeoParquet publication manifests and a signed, configured data URL for an operator-controlled GeoLibre deployment; it will not automate an undocumented GeoLibre internal API or transmit raw customer coordinates.

GeoLibre project-format verification (2026-08-19): the official project reference fixes the `.geolibre.json` version at `0.1.0`, supports a GeoJSON URL layer, and requires credential redaction before a project leaves the local workspace. The official embedding reference further confirms that a hosted viewer can load a project URL or a data URL, but private data requires a same-origin deployment or a signed expiring URL. UmojaFlowOS will generate a versioned blank-basemap project whose only layer points to a supplied aggregate-only signed data URL; it will reject embedded credentials, raw geometry, and non-HTTPS publication destinations.

The Python service already uses FastAPI `TestClient` for endpoint-level regression coverage. The new lakehouse, Sedona, and GeoLibre routes must therefore be tested both unconfigured (503 with an actionable but non-secret reason) and configured against real local protocol listeners; tests must restore environment variables because service configuration is intentionally read per request rather than cached.

Configuration contract alignment: Keycloak and TigerBeetle previously had no committed environment templates, and the existing OpenSearch, lakehouse, Sedona, and GeoLibre templates used names that did not match the deployed clients. Templates now name the exact `UMOJA_*` variables, stay disabled by default, use secret references rather than literal credentials, and require TLS or another explicit fail-closed control.

Edge-tier finding: the committed APISIX declarative configuration protects each control-plane and Go/Rust/Python service route with the Keycloak OpenID Connect plugin (`bearer_only`, discovery URL, client id, `ssl_verify: true`, 3-second timeout). The existing open-appsec template remains disabled and references management endpoint, agent-token secret, and policy bundle rather than literal values, but it does not yet carry the naming/transport controls used by the runtime clients. The next phase will align those contracts and add APISIX and Mojaloop protocol adapters without treating any gateway response as authorisation to execute a payment.

Edge source verification (2026-08-19): APISIX’s official open-appsec integration guidance specifies an embedded attachment plus an appsec agent, not an APISIX route plugin. The gateway must therefore be shipped in the open-appsec APISIX attachment image or matching Linux/Kubernetes integration, with a prevention-mode policy; adding an invented `openappsec` route plugin would not protect traffic. The official Mojaloop FSPIOP v1.1 definition specifies an asynchronous HTTPS API: a client-created UUID correlates the eventual callback, `POST` requests receive asynchronous completion through `PUT`, and source/destination/version/signature headers are part of the transport contract. UmojaFlowOS can construct and validate an accepted request, but never treats HTTP 202 as settled or an executable approval.

Mojaloop source finding: `services/payment-engine/internal/provider/mojaloop.go` contains only a disabled client and narrow input validation. The replacement must retain that disabled implementation, add a separate configured FSPIOP client, require the external authorisation signature, return the supplied instruction UUID only as an accepted asynchronous request reference, and reject every non-202 response or malformed/remote-plaintext destination. It must remain uncalled by the payment order workflow until the provider activation and authorised execution path are deliberately connected.
