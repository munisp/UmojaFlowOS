#!/usr/bin/env python3
"""Validate Prometheus Adapter external metrics and HPA against an explicit Kind/staging context."""
from __future__ import annotations
import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path


def run(*args: str) -> tuple[int, str]:
    p = subprocess.run(args, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    return p.returncode, p.stdout.strip()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--context", default="kind-umoja-staging")
    parser.add_argument("--namespace", default="umoja-payment")
    parser.add_argument("--hpa", default="fabric-attestation-queue-worker")
    parser.add_argument("--metric", default="umoja_fabric_queue_depth")
    parser.add_argument("--output", type=Path, default=Path("artifacts/staging/prometheus-adapter-hpa-validation.json"))
    args = parser.parse_args()
    result = {"context": args.context, "namespace": args.namespace, "metric": args.metric, "status": "FAIL", "live_cluster_evidence": False, "checks": []}
    required = ["kubectl"]
    missing = [tool for tool in required if shutil.which(tool) is None]
    if missing:
        result["checks"].append({"name": "required_tools", "status": "FAIL", "detail": f"missing: {', '.join(missing)}"})
        result["reason"] = "live Kind/Kubernetes validation cannot run without kubectl"
    else:
        rc, out = run("kubectl", "--context", args.context, "cluster-info")
        result["checks"].append({"name": "cluster_reachable", "status": "PASS" if rc == 0 else "FAIL", "detail": out})
        if rc == 0:
            commands = [
                ("adapter_api", ["kubectl", "--context", args.context, "get", "--raw", "/apis/external.metrics.k8s.io/v1beta1"]),
                ("queue_metric", ["kubectl", "--context", args.context, "get", "--raw", f"/apis/external.metrics.k8s.io/v1beta1/namespaces/{args.namespace}/{args.metric}"]),
                ("hpa_status", ["kubectl", "--context", args.context, "-n", args.namespace, "get", "hpa", args.hpa, "-o", "json"]),
            ]
            for name, command in commands:
                rc, out = run(*command)
                result["checks"].append({"name": name, "status": "PASS" if rc == 0 else "FAIL", "detail": out})
            result["live_cluster_evidence"] = all(c["status"] == "PASS" for c in result["checks"])
            result["status"] = "PASS" if result["live_cluster_evidence"] else "FAIL"
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    return 0 if result["status"] == "PASS" else 2


if __name__ == "__main__":
    raise SystemExit(main())
