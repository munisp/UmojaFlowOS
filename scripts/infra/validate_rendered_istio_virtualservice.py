#!/usr/bin/env python3
"""Fail-closed structural validation for rendered Istio VirtualServices.

Kubeconform validates built-in Kubernetes resources using offline schemas but
cannot resolve Istio CRDs without a cluster-specific CRD schema registry. This
validator covers the routing invariants UmojaFlowOS requires after Helm render.
It is deliberately narrow and rejects malformed or ambiguous route objects.
"""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Any

import yaml


class ValidationError(ValueError):
    """Raised when a rendered VirtualService violates a routing invariant."""


def require_mapping(value: Any, location: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValidationError(f"{location} must be an object")
    return value


def require_nonempty_string(value: Any, location: str) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{location} must be a non-empty string")
    return value.strip()


def require_list(value: Any, location: str) -> list[Any]:
    if not isinstance(value, list) or not value:
        raise ValidationError(f"{location} must be a non-empty list")
    return value


def validate_virtual_service(document: Any, index: int) -> None:
    document = require_mapping(document, f"document[{index}]")
    if document.get("kind") != "VirtualService":
        return
    if document.get("apiVersion") not in {"networking.istio.io/v1", "networking.istio.io/v1beta1"}:
        raise ValidationError(f"document[{index}].apiVersion must be an Istio networking v1 API")

    metadata = require_mapping(document.get("metadata"), f"document[{index}].metadata")
    require_nonempty_string(metadata.get("name"), f"document[{index}].metadata.name")

    spec = require_mapping(document.get("spec"), f"document[{index}].spec")
    for host_index, host in enumerate(require_list(spec.get("hosts"), f"document[{index}].spec.hosts")):
        require_nonempty_string(host, f"document[{index}].spec.hosts[{host_index}]")
    for gateway_index, gateway in enumerate(require_list(spec.get("gateways"), f"document[{index}].spec.gateways")):
        require_nonempty_string(gateway, f"document[{index}].spec.gateways[{gateway_index}]")

    for http_index, rule in enumerate(require_list(spec.get("http"), f"document[{index}].spec.http")):
        rule = require_mapping(rule, f"document[{index}].spec.http[{http_index}]")
        routes = require_list(rule.get("route"), f"document[{index}].spec.http[{http_index}].route")
        weight_total = 0
        for route_index, route in enumerate(routes):
            route = require_mapping(route, f"document[{index}].spec.http[{http_index}].route[{route_index}]")
            destination = require_mapping(
                route.get("destination"),
                f"document[{index}].spec.http[{http_index}].route[{route_index}].destination",
            )
            require_nonempty_string(
                destination.get("host"),
                f"document[{index}].spec.http[{http_index}].route[{route_index}].destination.host",
            )
            port = require_mapping(
                destination.get("port"),
                f"document[{index}].spec.http[{http_index}].route[{route_index}].destination.port",
            )
            number = port.get("number")
            if not isinstance(number, int) or not 1 <= number <= 65535:
                raise ValidationError(
                    f"document[{index}].spec.http[{http_index}].route[{route_index}].destination.port.number "
                    "must be an integer in 1..65535"
                )
            weight = route.get("weight")
            if not isinstance(weight, int) or not 0 <= weight <= 100:
                raise ValidationError(
                    f"document[{index}].spec.http[{http_index}].route[{route_index}].weight "
                    "must be an integer in 0..100"
                )
            weight_total += weight
        if weight_total != 100:
            raise ValidationError(f"document[{index}].spec.http[{http_index}].route weights must total 100, got {weight_total}")


def validate_rendered_manifest(path: Path) -> int:
    try:
        documents = list(yaml.safe_load_all(path.read_text(encoding="utf-8")))
    except (OSError, yaml.YAMLError) as error:
        raise ValidationError(f"cannot parse rendered manifest: {error}") from error

    virtual_service_count = 0
    for index, document in enumerate(documents, start=1):
        if document is None:
            continue
        if isinstance(document, dict) and document.get("kind") == "VirtualService":
            virtual_service_count += 1
        validate_virtual_service(document, index)
    if virtual_service_count == 0:
        raise ValidationError("rendered manifest contains no Istio VirtualService")
    return virtual_service_count


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    try:
        count = validate_rendered_manifest(args.manifest)
    except ValidationError as error:
        print(f"FAIL: {error}")
        return 1
    print(f"PASS: validated {count} Istio VirtualService document(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
