# Payment-Engine Helm Deployment Dependencies

## Runtime dependencies

The chart deploys the dedicated `fabric-attestation-worker` binary from the payment-engine image. The image must contain both `/app/payment-engine` and `/app/fabric-attestation-worker`, and the supplied value must be a full immutable `sha256:<64 lowercase hexadecimal>` digest. The chart fails during rendering if a mutable tag or placeholder is supplied.

The worker requires a PostgreSQL 16-compatible database containing migration `0057_fabric_attestation_queue.sql`. The referenced Secret must provide `queue-database-url`. Pool limits are set per replica and must remain below the database role and cluster connection budget.

The worker requires a read-only PVC containing the signed release evidence bundle. The bundle must include `manifest.json` and the four detached Ed25519 sidecars. The manifest must bind the deployment release SHA, environment, WORM bucket, Object Lock retention timestamp, reconciliation run ID, E-01–E-09 artifacts, and four distinct approval subjects.

## Secret and identity dependencies

In Vault mode, the worker requires the Vault address, object-storage KV path, and a token Secret. The Vault response must contain a version, access key, and secret key. A successful S3-compatible canary is required before refreshed credentials are accepted. Credentials must not be placed in Helm values, ConfigMaps, Git, or rendered manifests.

The object-storage credential Secret is retained for controlled non-Vault environments. Production should use Vault plus External Secrets Operator or an equivalent approved secret manager. The bucket must already enforce versioning, encryption, Object Lock retention, and deny-delete policy.

## Platform dependencies

The namespace must have Istio sidecar injection enabled, STRICT PeerAuthentication, and an AuthorizationPolicy matching the worker service account. The OTel Collector endpoint must be reachable over the configured protocol. Prometheus must scrape the metrics Service, and Prometheus Adapter must expose `umoja_fabric_queue_depth` through the external metrics API for HPA operation.

A Kubernetes cluster must support `apps/v1`, `autoscaling/v2`, `policy/v1`, projected service-account identity, read-only PVC mounts, and the configured security context. The deployment pipeline must run schema validation, detached signature verification, Helm rendering, Kubernetes server-side dry-run, admission checks, Istio analysis, and protected-environment approval before apply.

## Fail-closed conditions

The chart must not render without an immutable image digest, signed release-evidence claim, object-storage bucket, PostgreSQL Secret, Vault settings when Vault is enabled, or the configured four-role release gate. The worker must fail startup if PostgreSQL is unreachable, the initial queue refresh fails, the manifest is absent or invalid, a WORM bucket binding differs, credentials fail the canary, or the signed approval set is incomplete.

## Production gates

Live readiness requires a signed image and provenance attestation, a provisioned signed-evidence PVC, approved Vault and External Secrets bindings, PostgreSQL 16 migration evidence, live OTel and Prometheus scrape evidence, Prometheus Adapter external-metric verification, Istio STRICT and RBAC evidence, multi-replica queue tests, and an authorized rollback rehearsal. Helm template success alone is not production authorization.
