# Envoy Access-Log Streaming to Immutable Object Storage

## Purpose

This design removes high-volume Envoy access logs from the payment-engine pod and Kubernetes API path. A node-local Vector DaemonSet reads Kubernetes container logs, filters only payment-engine `istio-proxy` records, redacts sensitive fields, adds a bounded audit envelope, buffers to local disk, and writes gzip-compressed JSON objects to an S3-compatible endpoint such as MinIO, Ceph RGW, or another cloud-compatible object store.

The implementation is stored at `infra/logging/vector-envoy-worm.yaml`. It is cloud-agnostic at the application boundary: the destination is configured through `VECTOR_S3_ENDPOINT`, `VECTOR_S3_BUCKET`, and region/credential values delivered by a secret manager. Object immutability is a bucket policy and storage-class responsibility, not a property Vector can create by itself.

## Data flow

```text
Envoy sidecar stdout
        |
        v
Kubernetes container log files / API metadata
        |
        v
Vector DaemonSet: kubernetes_logs source
        |
        v
Filter: namespace=umoja-payment, container=istio-proxy
        |
        v
VRL normalization + sensitive-field deletion + audit envelope
        |
        v
Disk buffer, when_full=block
        |
        v
S3-compatible object storage: envoy-access/YYYY/MM/DD/HH/*.json.gz
        |
        v
WORM bucket with default retention + deny-delete policy
```

## Security controls

The Vector service account has only `get/list/watch` access to pods and namespaces. The DaemonSet runs non-root with `RuntimeDefault` seccomp, dropped capabilities, no privilege escalation, and a read-only root filesystem. Its sidecar is explicitly disabled because the collector must not create a telemetry feedback loop.

The transform removes access tokens, refresh tokens, authorization material, private keys, secrets, request bodies, response bodies, and raw destinations. The tenant field is bounded to a pod label or the literal `platform`; production must use an approved tenant-label admission policy and must not trust arbitrary user-controlled labels. The archive envelope retains response status, RBAC details, flags, trace/request correlation identifiers, route name, and source principal only when those fields are present.

Credentials are not committed. The included Secret is a deployment placeholder and must be replaced by External Secrets, Vault Agent, Sealed Secrets, or an equivalent open-source secret-delivery mechanism before staging. The storage endpoint must use TLS, and the object store must enforce server-side encryption, versioning, default Object Lock retention, and a deny-delete policy for the Vector publisher identity.

## Fail-closed delivery behavior

The Vector sink uses a disk buffer and `when_full = "block"`. If object storage is unavailable, Vector must back up locally and apply backpressure rather than silently discard evidence. The 10 GiB buffer is a starting staging value; size it from measured log rate, maximum outage interval, compression ratio, and node disk budget. Alert on buffer utilization, sink retry exhaustion, dropped events, parse failures, and filesystem pressure.

Because a DaemonSet buffer is node-local, it is not itself durable against node loss. For regulatory evidence, use a dedicated encrypted persistent volume for the buffer or deploy a node-level log agent with a durable local spool and a documented node-loss recovery procedure. The object-store bucket must be the authoritative WORM copy; a local buffer is only a delivery queue.

## Deployment and verification

Render and inspect the manifest:

```bash
kustomize build --load-restrictor LoadRestrictionsNone infra/logging \
  > artifacts/staging/vector-envoy-worm-rendered.yaml
kubectl apply --dry-run=server -f artifacts/staging/vector-envoy-worm-rendered.yaml
kubectl apply -f artifacts/staging/vector-envoy-worm-rendered.yaml
kubectl -n observability rollout status daemonset/vector-envoy-archive --timeout=10m
kubectl -n observability logs daemonset/vector-envoy-archive --since=10m
```

Before accepting evidence, verify that the bucket has default retention, versioning, encryption, and an explicit deny-delete rule for the publishing identity. Upload a synthetic record, verify its object key and gzip content, attempt a delete with the publisher credentials, and confirm the delete is rejected. Capture the storage audit log, Vector sink status, buffer utilization, object checksum, and retention metadata in the release evidence bundle.

## Fluent Bit alternative

Fluent Bit is a suitable lower-footprint alternative. Its equivalent topology is a DaemonSet with the `tail` input for `/var/log/containers/*_umoja-payment_*istio-proxy-*.log`, Kubernetes metadata enrichment, a Lua or modify filter that removes sensitive keys, a filesystem storage layer, and the `s3` output to an S3-compatible endpoint. Use `storage.type filesystem`, `storage.pause_on_chunks_overlimit true`, and a bounded `storage.max_chunks_up` value. Route through a dedicated service account only if Kubernetes metadata enrichment is required.

Vector is preferred for this repository because its remap language expresses typed field extraction, validation, and deletion in one reviewed configuration, and its disk buffer semantics make the `when_full=block` fail-closed choice explicit. Fluent Bit remains a valid alternative when node resource limits or an existing Fluent Bit platform standard outweigh transform expressiveness.

## Operational metrics and alerts

Monitor agent availability, input events, parse failures, sink events, retry counts, buffer bytes, buffer utilization, dropped events, object upload latency, object upload failures, and node disk usage. Alert at warning when the buffer exceeds 60% for five minutes, critical at 80% or any dropped-event counter increase, and page immediately when the WORM sink is unavailable beyond the approved evidence RPO. Thresholds must be calibrated from staging measurements rather than assumed from this design.

## Production gates

The configuration is not production-approved until the secret manager integration, immutable image digest/signature, storage Object Lock default retention, deny-delete policy, TLS trust chain, node-loss buffer strategy, tenant-isolation test, and end-to-end WORM deletion-denial evidence are complete. The architecture deliberately does not claim that a successful Vector pod rollout proves immutable archival.

## References

[1]: https://vector.dev/docs/reference/configuration/sources/kubernetes_logs/ "Vector Kubernetes Logs Source"

[2]: https://vector.dev/docs/reference/configuration/sinks/aws_s3/ "Vector AWS S3 Sink"

[3]: https://fluentbit.io/documentation/current/administration/buffering-and-storage/ "Fluent Bit Buffering and Storage"

[4]: https://kubernetes.io/docs/concepts/security/pod-security-standards/ "Kubernetes Pod Security Standards"
