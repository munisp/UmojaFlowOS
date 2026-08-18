# Cloud-agnostic lakehouse boundary

The Python reporting service produces immutable Bronze manifests and privacy-safe jurisdiction-level aggregation contracts. This template intentionally leaves all object-store, catalog, encryption, credential, and retention inputs unset; the lakehouse remains disabled until they are supplied through managed deployment configuration.

PostgreSQL control-plane evidence, TigerBeetle posting metadata, Dapr/Kafka events, document-intelligence evidence manifests, and permitted aggregate operational telemetry may enter the lakehouse only through versioned schemas and governed Bronze-to-Silver transformations. Raw KYC/KYB bytes, account numbers, tokens, provider credentials, and unredacted customer identifiers must not be exported.
