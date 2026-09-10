#!/usr/bin/env python3
"""Validate the settlement-liquidity Grafana dashboard and migration contract."""
from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

REQUIRED_METRICS = {
    "umoja_settlement_route_decisions_total",
    "umoja_settlement_liquidity_checks_total",
    "umoja_settlement_liquidity_denials_total",
    "umoja_settlement_liquidity_check_duration_ms",
}
REQUIRED_RLS = {
    "corridor_routes": "corridor_routes_tenant_isolation",
    "liquidity_treasury_evidence": "liquidity_evidence_tenant_isolation",
}


def fail(message: str) -> None:
    raise ValueError(message)


def collect_strings(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, dict):
        result: list[str] = []
        for item in value.values():
            result.extend(collect_strings(item))
        return result
    if isinstance(value, list):
        result = []
        for item in value:
            result.extend(collect_strings(item))
        return result
    return []


def validate_dashboard(path: Path, source: str) -> set[str]:
    dashboard = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(dashboard.get("panels"), list) or not dashboard["panels"]:
        fail("dashboard has no panels")

    strings = collect_strings(dashboard)
    referenced: set[str] = set()
    for text in strings:
        referenced.update(re.findall(r"umoja_settlement_[a-zA-Z0-9_]+", text))

    declared = set(re.findall(r'"(umoja_settlement_[a-zA-Z0-9_]+)"', source))
    normalized_referenced = {re.sub(r"_(bucket|sum|count)$", "", metric) for metric in referenced}
    missing_in_code = normalized_referenced - declared
    if missing_in_code:
        fail("dashboard references metrics absent from Go instrumentation: " + ", ".join(sorted(missing_in_code)))

    missing_required = REQUIRED_METRICS - normalized_referenced
    if missing_required:
        fail("dashboard is missing required metrics: " + ", ".join(sorted(missing_required)))

    raw = json.dumps(dashboard)
    if "tenant_id=~" not in raw:
        fail("dashboard queries do not apply tenant_id filtering")
    if "histogram_quantile(0.95" not in raw or "histogram_quantile(0.99" not in raw:
        fail("dashboard does not contain p95 and p99 latency queries")
    return referenced


def validate_migration(path: Path) -> None:
    sql = path.read_text(encoding="utf-8")
    normalized = re.sub(r"\s+", " ", sql.lower())
    for table, policy in REQUIRED_RLS.items():
        if f"alter table {table} enable row level security" not in normalized:
            fail(f"RLS is not enabled for {table}")
        if f"create policy {policy} on {table}" not in normalized:
            fail(f"required policy {policy} is missing")
        if f"using (tenant_id = current_setting('umoja.tenant_id', true))" not in normalized:
            fail(f"tenant USING predicate is missing for {table}")
        if f"with check (tenant_id = current_setting('umoja.tenant_id', true))" not in normalized:
            fail(f"tenant WITH CHECK predicate is missing for {table}")


def validate_prometheus(url: str, metrics: set[str]) -> None:
    base = url.rstrip("/") + "/api/v1/query"
    for metric in sorted(metrics):
        query = urllib.parse.urlencode({"query": f"count({metric})"})
        with urllib.request.urlopen(base + "?" + query, timeout=5) as response:
            payload = json.load(response)
        if payload.get("status") != "success":
            fail(f"Prometheus query failed for {metric}: {payload}")
        if payload.get("data", {}).get("resultType") not in {"vector", "scalar"}:
            fail(f"Prometheus returned an invalid result for {metric}: {payload}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dashboard", type=Path, required=True)
    parser.add_argument("--migration", type=Path, required=True)
    parser.add_argument("--go-source", type=Path, action="append", required=True)
    parser.add_argument("--prometheus-url")
    args = parser.parse_args()
    try:
        source = "\n".join(path.read_text(encoding="utf-8") for path in args.go_source)
        metrics = validate_dashboard(args.dashboard, source)
        validate_migration(args.migration)
        if args.prometheus_url:
            validate_prometheus(args.prometheus_url, metrics)
        print(json.dumps({"status": "PASS", "metrics": sorted(metrics), "prometheus_checked": bool(args.prometheus_url)}, indent=2))
        return 0
    except (OSError, ValueError, json.JSONDecodeError, urllib.error.URLError) as exc:
        print(f"VALIDATION_FAILED: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
