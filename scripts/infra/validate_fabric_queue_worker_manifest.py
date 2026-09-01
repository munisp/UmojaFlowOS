#!/usr/bin/env python3
import argparse
import re
from pathlib import Path
import yaml

parser = argparse.ArgumentParser()
parser.add_argument("--require-digest", action="store_true")
args = parser.parse_args()
path = Path(__file__).parents[2] / "infra/kubernetes/fabric-attestation-queue-worker.yaml"
docs = list(yaml.safe_load_all(path.read_text()))
objects = {(doc.get("kind"), doc.get("metadata", {}).get("name")): doc for doc in docs if doc}
required = {("ServiceAccount", "fabric-attestation-queue-worker"), ("Deployment", "fabric-attestation-queue-worker"), ("Service", "fabric-attestation-queue-worker"), ("PodDisruptionBudget", "fabric-attestation-queue-worker"), ("HorizontalPodAutoscaler", "fabric-attestation-queue-worker")}
missing = required - set(objects)
if missing:
    raise SystemExit(f"missing required objects: {sorted(missing)}")

deployment = objects[("Deployment", "fabric-attestation-queue-worker")]
pod = deployment["spec"]["template"]
container = next(c for c in pod["spec"]["containers"] if c["name"] == "queue-worker")
env = {item["name"]: item for item in container["env"]}
image = container["image"]
if not re.fullmatch(r".+@sha256:[0-9a-f]{64}", image):
    if args.require_digest or image != "ghcr.io/munisp/umojaflowos-payment-engine@sha256:REPLACE_WITH_RELEASE_DIGEST":
        raise SystemExit("queue-worker image must be an immutable sha256 digest before deployment")
for key, value in {"UMOJA_POSTGRES_MAX_OPEN_CONNS": "16", "UMOJA_POSTGRES_MAX_IDLE_CONNS": "8", "UMOJA_FABRIC_QUEUE_WORKERS": "2", "UMOJA_FABRIC_ADMISSION_LIMIT": "4", "UMOJA_FABRIC_QUEUE_METRICS_REFRESH_INTERVAL": "5s"}.items():
    if env.get(key, {}).get("value") != value:
        raise SystemExit(f"unexpected {key}")
if env.get("POD_NAMESPACE", {}).get("valueFrom", {}).get("fieldRef", {}).get("fieldPath") != "metadata.namespace":
    raise SystemExit("POD_NAMESPACE must use the Downward API")
if env.get("POD_NAME", {}).get("valueFrom", {}).get("fieldRef", {}).get("fieldPath") != "metadata.name":
    raise SystemExit("POD_NAME must use the Downward API")
if pod.get("metadata", {}).get("annotations", {}).get("sidecar.istio.io/inject") != "true":
    raise SystemExit("Istio sidecar injection must be enabled")
if container["readinessProbe"].get("httpGet", {}).get("port") != "metrics":
    raise SystemExit("readiness probe must use the metrics port")
hpa = objects[("HorizontalPodAutoscaler", "fabric-attestation-queue-worker")]
if hpa["spec"]["minReplicas"] != 2 or hpa["spec"]["maxReplicas"] != 8:
    raise SystemExit("unexpected HPA bounds")
external = next(m for m in hpa["spec"]["metrics"] if m["type"] == "External")
if external["external"]["metric"]["name"] != "umoja_fabric_queue_depth":
    raise SystemExit("HPA must use the queue-depth Prometheus Adapter metric")
print(f"PASS objects={len(objects)} image_digest={'required' if args.require_digest else 'template-guarded'} pool_open={env['UMOJA_POSTGRES_MAX_OPEN_CONNS']['value']} hpa=2..8")
