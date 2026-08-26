#!/usr/bin/env python3
"""Create a validated report for the scheduled retention PostgreSQL pool-saturation test."""
from __future__ import annotations

import argparse
import json
import os
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


QUERIES = {
    "pool_saturation_failures": 'sum(increase(umoja_retention_worker_failures_total{result="database_connection_pool_saturated"}[15m]))',
    "max_pool_waiting": 'max_over_time(umoja_retention_worker_db_pool_waiting[15m])',
    "max_lock_wait_seconds": 'max_over_time(pg_retention_lock_wait_max_wait_seconds{environment="staging"}[15m])',
    "worker_up": 'min_over_time(up{job="umoja-retention-worker"}[15m])',
}


def query(base_url: str, expression: str, token: str | None) -> float | None:
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    url = f"{base_url.rstrip('/')}/api/v1/query?{urlencode({'query': expression})}"
    with urlopen(Request(url, headers=headers), timeout=30) as response:
        body = json.loads(response.read())
    if body.get("status") != "success":
        raise RuntimeError(f"Prometheus query failed: {body}")
    results = body.get("data", {}).get("result", [])
    if not results:
        return None
    values = [float(item["value"][1]) for item in results if item.get("value")]
    return max(values) if values else None


def junit_status(path: Path) -> dict[str, int]:
    root = ET.parse(path).getroot()
    suites = [root] if root.tag == "testsuite" else list(root.iter("testsuite"))
    return {
        "tests": sum(int(suite.attrib.get("tests", 0)) for suite in suites),
        "failures": sum(int(suite.attrib.get("failures", 0)) for suite in suites),
        "errors": sum(int(suite.attrib.get("errors", 0)) for suite in suites),
        "skipped": sum(int(suite.attrib.get("skipped", 0)) for suite in suites),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--junit", required=True)
    parser.add_argument("--prometheus-url", default=os.getenv("PROMETHEUS_URL"), required=os.getenv("PROMETHEUS_URL") is None)
    parser.add_argument("--bearer-token-file", default=os.getenv("PROMETHEUS_BEARER_TOKEN_FILE"))
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--environment", default=os.getenv("CHAOS_ENVIRONMENT", "staging"))
    args = parser.parse_args()
    token = Path(args.bearer_token_file).read_text().strip() if args.bearer_token_file else None
    junit = junit_status(Path(args.junit))
    observed = {name: query(args.prometheus_url, expression, token) for name, expression in QUERIES.items()}
    validation = {
        "junit_passed": junit["tests"] >= 1 and junit["failures"] == 0 and junit["errors"] == 0,
        "pool_saturation_observed": observed["pool_saturation_failures"] is not None and observed["pool_saturation_failures"] >= 1,
        "worker_available": observed["worker_up"] == 1,
        "staging_target": args.environment == "staging",
    }
    validation["passed"] = all(validation.values())
    report = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "environment": args.environment,
        "window": {"start": (datetime.now(timezone.utc) - timedelta(minutes=15)).isoformat(), "duration": "15m"},
        "junit": junit,
        "metrics": observed,
        "validation": validation,
    }
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    (output / "chaos-pool-saturation-report.json").write_text(json.dumps(report, indent=2) + "\n")
    (output / "chaos-pool-saturation-report.md").write_text(
        "# Weekly Retention PostgreSQL Pool Saturation Report\n\n"
        f"Generated: {report['generated_at']}\n\n"
        "| Check | Result |\n|---|---|\n"
        f"| JUnit tests | {junit['tests']} tests, {junit['failures']} failures, {junit['errors']} errors |\n"
        f"| Pool-saturation failures observed | {observed['pool_saturation_failures']} |\n"
        f"| Maximum pool waiters | {observed['max_pool_waiting']} |\n"
        f"| Maximum PostgreSQL lock wait (s) | {observed['max_lock_wait_seconds']} |\n"
        f"| Worker available | {observed['worker_up']} |\n"
        f"| Validation passed | {validation['passed']} |\n"
    )
    print(json.dumps({"output_dir": str(output), "passed": validation["passed"]}))
    if not validation["passed"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
