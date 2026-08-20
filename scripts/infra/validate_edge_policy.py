#!/usr/bin/env python3
"""Validate the declarative APISIX / open-appsec edge security contract.

This is deliberately a configuration validator, not a simulated gateway. The
open-appsec attachment and agent execute at ingress in a provisioned edge
environment, while this script prevents a committed APISIX route from silently
dropping its OIDC guard, TLS verification, or required service coverage.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parents[2]
CONFIG = ROOT / "infra" / "apisix" / "apisix.yaml"
EXPECTED_ROUTES = {
    "control-plane-api": "/api/*",
    "payment-engine-api": "/payment-engine/*",
    "risk-compliance-api": "/risk-compliance/*",
    "ledger-gateway-api": "/ledger-gateway/*",
    "reporting-api": "/reporting/*",
}


def validate(raw: object) -> list[str]:
    failures: list[str] = []
    routes = raw.get("routes") if isinstance(raw, dict) else None
    if not isinstance(routes, list):
        failures.append("APISIX configuration has no routes list")
        routes = []
    found: dict[str, str] = {}
    for route in routes:
        if not isinstance(route, dict):
            failures.append("APISIX configuration contains a non-object route")
            continue
        route_id = route.get("id")
        uri = route.get("uri")
        if isinstance(route_id, str) and isinstance(uri, str):
            found[route_id] = uri
        upstream = route.get("upstream")
        plugins = route.get("plugins")
        oidc = plugins.get("openid-connect") if isinstance(plugins, dict) else None
        opa = plugins.get("opa") if isinstance(plugins, dict) else None
        limit_req = plugins.get("limit-req") if isinstance(plugins, dict) else None
        limit_conn = plugins.get("limit-conn") if isinstance(plugins, dict) else None
        limit_count = plugins.get("limit-count") if isinstance(plugins, dict) else None
        if not isinstance(upstream, dict) or upstream.get("scheme") != "http" or not upstream.get("nodes"):
            failures.append(f"{route_id}: must define a private upstream")
        if not isinstance(oidc, dict):
            failures.append(f"{route_id}: missing openid-connect gateway guard")
            continue
        if oidc.get("bearer_only") is not True:
            failures.append(f"{route_id}: bearer_only must be true")
        if oidc.get("ssl_verify") is not True:
            failures.append(f"{route_id}: OIDC TLS verification must be true")
        if oidc.get("timeout") != 3000:
            failures.append(f"{route_id}: OIDC timeout must be exactly 3000 ms")
        if oidc.get("discovery") != "${KEYCLOAK_OIDC_DISCOVERY_URL}":
            failures.append(f"{route_id}: must use the configured Keycloak discovery URL")
        if oidc.get("client_id") != "umojaflowos-gateway" or oidc.get("realm") != "umojaflowos":
            failures.append(f"{route_id}: must use the UmojaFlowOS gateway client and realm")
        if not isinstance(opa, dict) or opa.get("policy") != "umojaflowos/gateway" or opa.get("ssl_verify") is not True:
            failures.append(f"{route_id}: missing fail-closed OPA policy guard")
        if not isinstance(limit_req, dict) or limit_req.get("rejected_code") != 429:
            failures.append(f"{route_id}: missing request-rate limit")
        if not isinstance(limit_conn, dict) or limit_conn.get("rejected_code") != 429:
            failures.append(f"{route_id}: missing connection limit")
        if not isinstance(limit_count, dict) or limit_count.get("policy") != "redis" or limit_count.get("redis_ssl_verify") is not True or limit_count.get("allow_degradation") is not False:
            failures.append(f"{route_id}: missing Redis-backed fail-closed quota")
    if found != EXPECTED_ROUTES:
        failures.append(f"APISIX service routes differ from the approved set: {found!r}")
    return failures


def main() -> int:
    failures = validate(yaml.safe_load(CONFIG.read_text(encoding="utf-8")))
    if failures:
        print("\n".join(failures), file=sys.stderr)
        return 1
    print(f"validated {len(EXPECTED_ROUTES)} APISIX routes with mandatory OIDC guard; open-appsec attachment is required by infra/openappsec/openappsec.env.template")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
