#!/usr/bin/env python3
from pathlib import Path
import re
import yaml

root = Path(__file__).parents[2]
worker_docs = [d for d in yaml.safe_load_all((root / "infra/kubernetes/fabric-attestation-queue-worker.yaml").read_text()) if d]
keys = {(d["kind"], d["metadata"]["name"]): d for d in worker_docs}
d = keys[("Deployment", "fabric-attestation-queue-worker")]
c = next(c for c in d["spec"]["template"]["spec"]["containers"] if c["name"] == "queue-worker")
if c["command"] != ["/app/fabric-attestation-worker"]:
    raise SystemExit("Deployment must run the dedicated worker binary")
if not re.fullmatch(r".+@sha256:[0-9a-f]{64}", c["image"]) and "REPLACE_WITH_RELEASE_DIGEST" not in c["image"]:
    raise SystemExit("image must be digest-pinned or an explicit guarded template")
if d["spec"]["replicas"] != 2 or keys[("HorizontalPodAutoscaler", "fabric-attestation-queue-worker")]["spec"]["maxReplicas"] != 8:
    raise SystemExit("unexpected worker replica bounds")
hpa = keys[("HorizontalPodAutoscaler", "fabric-attestation-queue-worker")]
external = next(m for m in hpa["spec"]["metrics"] if m["type"] == "External")
if external["external"]["metric"]["name"] != "umoja_fabric_queue_depth":
    raise SystemExit("HPA queue metric mismatch")
adapter = list(yaml.safe_load_all((root / "infra/monitoring/prometheus-adapter-fabric-queue.yaml").read_text()))
if len(adapter) != 2 or "umoja_fabric_queue_depth" not in adapter[0]["data"]["config.yaml"]:
    raise SystemExit("adapter configuration missing queue metric")
print("PASS dedicated_worker=true replicas=2..8 adapter_metric=umoja_fabric_queue_depth")
