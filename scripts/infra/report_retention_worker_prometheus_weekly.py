#!/usr/bin/env python3
"""Generate a weekly retention-worker regression report from Prometheus.

The report consumes only returned Prometheus samples. It produces JSON and
Markdown suitable for an immutable CI artifact or controlled evidence store.
"""
from __future__ import annotations

import argparse
import json
import math
import os
import statistics
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlencode
from urllib.request import Request, urlopen


METRICS = {
    "unique_requests_per_second": {
        "unit": "req/s",
        "query": 'sum(rate(umoja_locust_requests_total{scenario="unique"}[1m]))',
    },
    "contention_requests_per_second": {
        "unit": "req/s",
        "query": 'sum(rate(umoja_locust_requests_total{scenario="contention"}[1m]))',
    },
    "unique_locust_p95_seconds": {
        "unit": "s",
        "query": 'histogram_quantile(0.95, sum by (le) (rate(umoja_locust_request_duration_seconds_bucket{scenario="unique"}[5m])))',
    },
    "contention_locust_p95_seconds": {
        "unit": "s",
        "query": 'histogram_quantile(0.95, sum by (le) (rate(umoja_locust_request_duration_seconds_bucket{scenario="contention"}[5m])))',
    },
    "postgres_max_lock_wait_seconds": {
        "unit": "s",
        "query": 'max(pg_retention_lock_wait_max_wait_seconds{environment="staging"})',
    },
    "postgres_lock_waiting_sessions": {
        "unit": "sessions",
        "query": 'max(pg_retention_lock_wait_waiting_sessions{environment="staging"})',
    },
    "worker_p95_execution_seconds": {
        "unit": "s",
        "query": 'histogram_quantile(0.95, sum by (le) (rate(umoja_retention_worker_execution_seconds_bucket[5m])))',
    },
    "security_failures_per_second": {
        "unit": "failures/s",
        "query": 'sum(rate(umoja_retention_worker_failures_total{result=~"opensearch_authentication_failure|opensearch_authorization_failure"}[5m]))',
    },
}


def percentile(values: list[float], pct: float) -> float:
    if not values:
        return math.nan
    ordered = sorted(values)
    position = (len(ordered) - 1) * pct
    lower, upper = math.floor(position), math.ceil(position)
    if lower == upper:
        return ordered[lower]
    return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower)


def make_request(url: str, token: str | None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return headers


def query_range(base_url: str, query: str, start: datetime, end: datetime, step: int, token: str | None) -> list[float]:
    parameters = urlencode({
        "query": query,
        "start": start.timestamp(),
        "end": end.timestamp(),
        "step": step,
    })
    request = Request(f"{base_url.rstrip('/')}/api/v1/query_range?{parameters}", headers=make_request(base_url, token))
    with urlopen(request, timeout=30) as response:
        body = json.loads(response.read())
    if body.get("status") != "success":
        raise RuntimeError(f"Prometheus query failed: {body}")
    values: list[float] = []
    for result in body.get("data", {}).get("result", []):
        for _timestamp, raw_value in result.get("values", []):
            try:
                value = float(raw_value)
            except (TypeError, ValueError):
                continue
            if math.isfinite(value):
                values.append(value)
    return values


def summarize(values: list[float]) -> dict[str, float | int | None]:
    if not values:
        return {"samples": 0, "minimum": None, "mean": None, "median": None, "p95": None, "maximum": None}
    return {
        "samples": len(values),
        "minimum": min(values),
        "mean": statistics.fmean(values),
        "median": statistics.median(values),
        "p95": percentile(values, 0.95),
        "maximum": max(values),
    }


def fmt(value: float | int | None, unit: str) -> str:
    if value is None:
        return "no samples"
    return f"{float(value):.3f} {unit}"


def markdown(summary: dict, start: datetime, end: datetime) -> str:
    lines = [
        "# UmojaFlowOS Retention Worker Weekly Performance Regression Report",
        "",
        f"Window: {start.isoformat()} to {end.isoformat()}",
        "",
        "This report contains observed Prometheus samples only. An absent series is reported as `no samples`; it is not interpreted as a healthy value.",
        "",
        "| Metric | Samples | Mean | p95 | Maximum |",
        "|---|---:|---:|---:|---:|",
    ]
    for name, details in summary["metrics"].items():
        stats = details["statistics"]
        unit = details["unit"]
        lines.append(
            f"| {name} | {stats['samples']} | {fmt(stats['mean'], unit)} | {fmt(stats['p95'], unit)} | {fmt(stats['maximum'], unit)} |"
        )
    lines.extend([
        "",
        "## Regression gates",
        "",
        "- Investigate any Locust p95 sample above the configured 5-second alert threshold.",
        "- Escalate any PostgreSQL lock-wait maximum above the 2-second critical threshold during an active test.",
        "- Treat nonzero authentication or authorization failure samples as a security investigation, not a performance regression.",
        "- Compare this artifact with the prior approved week only after confirming identical test profile, image digest, and PostgreSQL configuration.",
        "",
    ])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--prometheus-url", default=os.getenv("PROMETHEUS_URL"), required=os.getenv("PROMETHEUS_URL") is None)
    parser.add_argument("--bearer-token-file", default=os.getenv("PROMETHEUS_BEARER_TOKEN_FILE"))
    parser.add_argument("--days", type=int, default=7)
    parser.add_argument("--step-seconds", type=int, default=300)
    parser.add_argument("--output-dir", default="/tmp/retention-weekly-performance-report")
    args = parser.parse_args()
    if args.days <= 0 or args.step_seconds <= 0:
        parser.error("days and step-seconds must be positive")

    token = Path(args.bearer_token_file).read_text().strip() if args.bearer_token_file else None
    end = datetime.now(timezone.utc)
    start = end - timedelta(days=args.days)
    results = {"generated_at": end.isoformat(), "window_start": start.isoformat(), "window_end": end.isoformat(), "metrics": {}}
    query_errors: dict[str, str] = {}
    for name, definition in METRICS.items():
        try:
            values = query_range(args.prometheus_url, definition["query"], start, end, args.step_seconds, token)
            results["metrics"][name] = {"query": definition["query"], "unit": definition["unit"], "statistics": summarize(values)}
        except Exception as exc:  # report every failed query rather than hiding it
            query_errors[name] = str(exc)
            results["metrics"][name] = {"query": definition["query"], "unit": definition["unit"], "statistics": summarize([])}
    results["query_errors"] = query_errors

    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    (output / "weekly-summary.json").write_text(json.dumps(results, indent=2) + "\n")
    (output / "weekly-summary.md").write_text(markdown(results, start, end))
    print(json.dumps({"output_dir": str(output), "query_errors": query_errors}, indent=2))
    if query_errors:
        sys.exit(1)


if __name__ == "__main__":
    main()
