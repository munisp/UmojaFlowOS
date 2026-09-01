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


def _json_access_log_lines(text: str) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    for line in text.splitlines():
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            continue
        if isinstance(value, dict):
            records.append(value)
    return records


def _assert_envoy_status(records: list[dict[str, Any]], expected_code: int, denied: bool) -> None:
    matching = [record for record in records if str(record.get("response_code", "")) == str(expected_code)]
    if not matching:
        raise CheckFailure(f"no structured Envoy access-log record with response_code={expected_code}")
    if denied:
        details = " ".join(str(record.get(key, "")) for record in matching for key in ("response_code_details", "response_flags", "istio_policy_status"))
        if "rbac" not in details.lower() and "denied" not in details.lower():
            raise CheckFailure("403 record did not identify Envoy RBAC denial in response_code_details/response_flags/istio_policy_status")
    else:
        details = " ".join(str(record.get(key, "")) for record in matching for key in ("response_code_details", "response_flags", "istio_policy_status"))
        if "rbac_access_denied" in details.lower() or "denied" in details.lower():
            raise CheckFailure("allowlisted request was marked as an RBAC denial")


def live_checks(args: argparse.Namespace) -> list[str]:
    for tool in ("kubectl", "istioctl", "grpcurl", "jq"):
        if shutil.which(tool) is None:
            raise CheckFailure(f"{tool} is required for --live")
    output: list[str] = []
    # These paths are intentionally resolved inside the pre-created test pod,
    # not on the CI runner. The pod must mount the approved client material,
    # request fixture, and protobuf source at these paths.
    run(["kubectl", "config", "current-context"])
    run(["kubectl", "-n", args.namespace, "rollout", "status", "deploy/payment-engine", "--timeout=60s"])
    run(["istioctl", "proxy-status"])
    run(["istioctl", "authn", "tls-check", f"{args.allowed_pod}.{args.allowed_namespace}", f"payment-engine.{args.namespace}.svc.cluster.local"])
    run(["istioctl", "x", "authz", "check", "deploy/payment-engine", "-n", args.namespace])

    target = f"payment-engine.{args.namespace}.svc.cluster.local:8443"
    method = "umoja.settlement.v1.Settlement/Execute"
    allowed_command = [
        "grpcurl", "-proto", args.proto, "-import-path", str(Path(args.proto).parent),
        "-cacert", args.tls_ca, "-cert", args.tls_cert, "-key", args.tls_key,
        "-d", f"@{args.request_file}", target, method,
    ]
    allowed_code, allowed_output = run(["kubectl", "-n", args.allowed_namespace, "exec", args.allowed_pod, "-c", args.allowed_container, "--", *allowed_command], allow_failure=True)
    if allowed_code != 0:
        raise CheckFailure(f"allowlisted typed Execute call failed; this is not an authorization success:\n{allowed_output}")
    if "PERMISSION_DENIED" in allowed_output or "UNAUTHENTICATED" in allowed_output:
        raise CheckFailure(f"allowlisted typed Execute call returned an authorization error:\n{allowed_output}")
    output.append("allowlisted typed Execute call completed without authorization error")

    denied_command = [
        "grpcurl", "-proto", args.proto, "-import-path", str(Path(args.proto).parent),
        "-plaintext", target, "list",
    ]
    denied_code, denied_output = run(["kubectl", "-n", args.denied_namespace, "exec", args.denied_pod, "-c", args.denied_container, "--", *denied_command], allow_failure=True)
    if denied_code == 0:
        raise CheckFailure("unallowlisted plaintext probe unexpectedly succeeded")
    if "PERMISSION_DENIED" not in denied_output and "403" not in denied_output and "RBAC" not in denied_output.upper():
        raise CheckFailure(f"denied probe failed without a structured authorization signal:\n{denied_output}")
    output.append("unallowlisted plaintext probe failed with an authorization signal")

    _, access_logs = run(["kubectl", "-n", args.namespace, "logs", "deploy/payment-engine", "-c", "istio-proxy", "--since=2m"], allow_failure=True)
    records = _json_access_log_lines(access_logs)
    if not records:
        raise CheckFailure("payment-engine istio-proxy emitted no JSON access-log records; structured RBAC verification is unavailable")
    _assert_envoy_status(records, 200, denied=False)
    _assert_envoy_status(records, 403, denied=True)
    output.append("structured Envoy access logs proved 200 allow and 403 RBAC deny")
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
    parser.add_argument("--allowed-container", default="grpcurl")
    parser.add_argument("--tls-ca", default="/run/secrets/settlement/ca.crt", help="approved CA path inside allowed pod")
    parser.add_argument("--tls-cert", default="/run/secrets/settlement/client.crt", help="approved client certificate path inside allowed pod")
    parser.add_argument("--tls-key", default="/run/secrets/settlement/client.key", help="approved client key path inside allowed pod")
    parser.add_argument("--request-file", default="/run/config/settlement-request.json", help="synthetic request path inside allowed pod")
    parser.add_argument("--proto", default="/run/config/settlement.proto", help="protobuf path inside allowed pod")
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
