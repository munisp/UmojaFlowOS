#!/usr/bin/env python3
"""Validate and optionally exercise the staging settlement gRPC security boundary.

Static mode is safe on a workstation and validates the rendered Kustomize output
and Istio policy bundle. Live mode requires an approved staging kube-context and
pre-created test pods; it never creates credentials or changes policies.
"""
from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any

try:
    import yaml
except ImportError as exc:  # pragma: no cover
    raise SystemExit("PyYAML is required: pip install pyyaml") from exc


class CheckFailure(RuntimeError):
    pass


def load_objects(path: Path) -> list[dict[str, Any]]:
    with path.open(encoding="utf-8") as handle:
        return [obj for obj in yaml.safe_load_all(handle) if isinstance(obj, dict)]


def one(objects: list[dict[str, Any]], kind: str, name: str, namespace: str | None = None) -> dict[str, Any]:
    matches = [obj for obj in objects if obj.get("kind") == kind and obj.get("metadata", {}).get("name") == name]
    if namespace is not None:
        matches = [obj for obj in matches if obj.get("metadata", {}).get("namespace") == namespace]
    if len(matches) != 1:
        raise CheckFailure(f"expected exactly one {kind}/{name}, found {len(matches)}")
    return matches[0]


def assert_equal(actual: Any, expected: Any, label: str) -> None:
    if actual != expected:
        raise CheckFailure(f"{label}: expected {expected!r}, got {actual!r}")


def static_checks(rendered: Path, policy: Path, namespace: str) -> list[str]:
    rendered_objects = load_objects(rendered)
    policy_objects = load_objects(policy)
    service = one(rendered_objects, "Service", "payment-engine", namespace)
    deployment = one(rendered_objects, "Deployment", "payment-engine", namespace)
    peer_auth = one(policy_objects, "PeerAuthentication", "settlement-grpc-strict-mtls", namespace)
    authz = one(policy_objects, "AuthorizationPolicy", "settlement-grpc-allowlisted-callers", namespace)
    service_entry = one(policy_objects, "ServiceEntry", "settlement-grpc", namespace)
    destination_rule = one(policy_objects, "DestinationRule", "settlement-grpc-mtls", namespace)

    service_ports = {port.get("name"): port for port in service.get("spec", {}).get("ports", [])}
    grpc_port = service_ports.get("grpc-tls")
    if grpc_port is None:
        raise CheckFailure("Service is missing named grpc-tls port")
    assert_equal(grpc_port.get("port"), 8443, "Service grpc-tls port")
    assert_equal(grpc_port.get("targetPort"), "grpc-tls", "Service grpc-tls targetPort")

    pod = deployment["spec"]["template"]
    annotations = pod.get("metadata", {}).get("annotations", {})
    assert_equal(annotations.get("sidecar.istio.io/inject"), "true", "sidecar injection")
    container = next((item for item in pod["spec"]["containers"] if item.get("name") == "payment-engine"), None)
    if container is None:
        raise CheckFailure("payment-engine container not found")
    ports = {port.get("name"): port for port in container.get("ports", [])}
    if ports.get("grpc-tls", {}).get("containerPort") != 8443:
        raise CheckFailure("payment-engine container does not expose grpc-tls on 8443")
    env = {item.get("name"): item.get("value") for item in container.get("env", [])}
    required_env = {
        "GRPC_SETTLEMENT_LISTEN_ADDR": ":8443",
        "GRPC_SETTLEMENT_EXECUTION_ENABLED": "false",
        "GRPC_SETTLEMENT_CA_FILE": "/var/run/umoja-settlement-grpc/ca.crt",
        "GRPC_SETTLEMENT_CERT_FILE": "/var/run/umoja-settlement-grpc/tls.crt",
        "GRPC_SETTLEMENT_KEY_FILE": "/var/run/umoja-settlement-grpc/tls.key",
    }
    for key, expected in required_env.items():
        assert_equal(env.get(key), expected, f"Deployment env {key}")
    if not any(item.get("name") == "settlement-grpc-server-mtls" for item in pod["spec"].get("volumes", [])):
        raise CheckFailure("server mTLS secret volume is missing")
    if not any(item.get("name") == "settlement-grpc-server-mtls" for item in container.get("volumeMounts", [])):
        raise CheckFailure("server mTLS secret mount is missing")

    assert_equal(peer_auth.get("spec", {}).get("mtls", {}).get("mode"), "STRICT", "PeerAuthentication mTLS mode")
    rules = authz.get("spec", {}).get("rules", [])
    principals = {p for rule in rules for source in rule.get("from", []) for p in source.get("source", {}).get("principals", [])}
    expected_principals = {
        "cluster.local/ns/umoja-control/sa/control-plane",
        "cluster.local/ns/umoja-payment/sa/reconciliation-worker",
    }
    assert_equal(principals, expected_principals, "AuthorizationPolicy principals")
    operations = [operation for rule in rules for target in rule.get("to", []) for operation in [target.get("operation", {})]]
    if not any("8443" in operation.get("ports", []) and "POST" in operation.get("methods", []) for operation in operations):
        raise CheckFailure("AuthorizationPolicy does not constrain POST on 8443")
    assert_equal(destination_rule.get("spec", {}).get("trafficPolicy", {}).get("tls", {}).get("mode"), "ISTIO_MUTUAL", "DestinationRule TLS mode")
    host = "payment-engine.umoja-payment.svc.cluster.local"
    assert_equal(service_entry.get("spec", {}).get("hosts"), [host], "ServiceEntry host")
    assert_equal(destination_rule.get("spec", {}).get("host"), host, "DestinationRule host")
    return [f"static checks passed: {rendered.name} + {policy.name}"]


def run(command: list[str], *, allow_failure: bool = False) -> tuple[int, str]:
    result = subprocess.run(command, text=True, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, check=False)
    if result.returncode and not allow_failure:
        raise CheckFailure(f"command failed ({result.returncode}): {' '.join(command)}\n{result.stdout}")
    return result.returncode, result.stdout


def live_checks(args: argparse.Namespace) -> list[str]:
    for tool in ("kubectl", "istioctl"):
        if shutil.which(tool) is None:
            raise CheckFailure(f"{tool} is required for --live")
    output: list[str] = []
    run(["kubectl", "config", "current-context"])
    run(["kubectl", "-n", args.namespace, "rollout", "status", "deploy/payment-engine", "--timeout=60s"])
    run(["istioctl", "proxy-status"])
    run(["istioctl", "authn", "tls-check", f"{args.allowed_pod}.{args.allowed_namespace}", f"payment-engine.{args.namespace}.svc.cluster.local"])
    run(["istioctl", "x", "authz", "check", "deploy/payment-engine", "-n", args.namespace])
    _, denied_output = run(
        ["kubectl", "-n", args.denied_namespace, "exec", args.denied_pod, "-c", args.denied_container, "--", "grpcurl", "-plaintext", f"payment-engine.{args.namespace}.svc.cluster.local:8443", "list"],
        allow_failure=True,
    )
    if "PermissionDenied" not in denied_output and "RBAC" not in denied_output and "denied" not in denied_output.lower():
        raise CheckFailure("denied-principal probe did not produce an authorization denial")
    output.append("negative authorization probe produced denial")
    return output


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--rendered", type=Path, default=Path("artifacts/staging/payment-engine-grpc-staging-rendered.yaml"))
    parser.add_argument("--policy", type=Path, default=Path("infra/service-mesh/settlement-grpc-mtls-staging.yaml"))
    parser.add_argument("--namespace", default="umoja-payment")
    parser.add_argument("--live", action="store_true")
    parser.add_argument("--allowed-pod", default="settlement-grpc-loadgen")
    parser.add_argument("--allowed-namespace", default="umoja-control")
    parser.add_argument("--denied-pod", default="settlement-grpc-denied")
    parser.add_argument("--denied-namespace", default="umoja-payment")
    parser.add_argument("--denied-container", default="grpcurl")
    args = parser.parse_args()
    try:
        messages = static_checks(args.rendered, args.policy, args.namespace)
        if args.live:
            messages.extend(live_checks(args))
        print(json.dumps({"status": "PASS", "live": args.live, "checks": messages}, indent=2))
        return 0
    except (CheckFailure, FileNotFoundError, yaml.YAMLError) as exc:
        print(json.dumps({"status": "FAIL", "error": str(exc)}, indent=2))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
