# OpenSearch Audit Projection Boundary

This configuration is intentionally disabled. When enabled, the reporting service may project only the redacted, non-monetary audit document defined by `services/reporting-analytics/src/umojaflowos_reporting/opensearch_projection.py`.

The endpoint must be private and TLS-verified. Populate every `*_SECRET_REF` through the deployment secret manager; do not place credentials, certificates, account identifiers, document bytes, monetary amounts, or raw customer data in this repository or the index.
