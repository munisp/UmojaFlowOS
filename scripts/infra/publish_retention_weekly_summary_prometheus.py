#!/usr/bin/env python3
"""Publish a weekly retention summary JSON as Prometheus gauges.

Use --output-textfile with a node_exporter textfile collector or --pushgateway-url
for a protected internal Pushgateway. The script intentionally reads JSON rather
than parsing Markdown tables, which are presentation output rather than an API.
"""
from __future__ import annotations

import argparse
import json
import math
import os
from pathlib import Path
from urllib.request import Request, urlopen


STATISTICS = ("minimum", "mean", "median", "p95", "maximum")


def escape_label(value: str) -> str:
    return value.replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')


def render(summary: dict) -> str:
    lines = [
        "# HELP umoja_retention_weekly_report_value Observed weekly retention worker regression metric.",
        "# TYPE umoja_retention_weekly_report_value gauge",
    ]
    report_timestamp = summary.get("generated_at")
    if not report_timestamp or not summary.get("metrics"):
        raise ValueError("weekly summary must include generated_at and metrics")
    for metric_name, detail in sorted(summary["metrics"].items()):
        unit = detail.get("unit")
        statistics = detail.get("statistics", {})
        if not unit or not isinstance(statistics, dict):
            raise ValueError(f"invalid metric entry: {metric_name}")
        for statistic in STATISTICS:
            value = statistics.get(statistic)
            if value is None:
                continue
            numeric = float(value)
            if not math.isfinite(numeric):
                raise ValueError(f"non-finite value for {metric_name}/{statistic}")
            labels = f'metric="{escape_label(metric_name)}",statistic="{statistic}",unit="{escape_label(unit)}"'
            lines.append(f"umoja_retention_weekly_report_value{{{labels}}} {numeric}")
    lines.extend([
        "# HELP umoja_retention_weekly_report_generated Timestamp of the JSON report generation.",
        "# TYPE umoja_retention_weekly_report_generated gauge",
        f"umoja_retention_weekly_report_generated{{environment=\"staging\"}} {report_timestamp_to_epoch(report_timestamp)}",
        "",
    ])
    return "\n".join(lines)


def report_timestamp_to_epoch(value: str) -> float:
    from datetime import datetime
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError("generated_at must include a timezone")
    return parsed.timestamp()


def post_pushgateway(base_url: str, body: str, token: str | None) -> None:
    endpoint = f"{base_url.rstrip('/')}/metrics/job/umoja_retention_weekly_report"
    headers = {"Content-Type": "text/plain; version=0.0.4"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(endpoint, data=body.encode(), headers=headers, method="PUT")
    with urlopen(request, timeout=30) as response:
        if not 200 <= response.status < 300:
            raise RuntimeError(f"Pushgateway returned HTTP {response.status}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary-json", required=True)
    parser.add_argument("--output-textfile")
    parser.add_argument("--pushgateway-url", default=os.getenv("PROMETHEUS_PUSHGATEWAY_URL"))
    parser.add_argument("--bearer-token-file", default=os.getenv("PROMETHEUS_PUSHGATEWAY_BEARER_TOKEN_FILE"))
    args = parser.parse_args()
    if bool(args.output_textfile) == bool(args.pushgateway_url):
        parser.error("choose exactly one of --output-textfile or --pushgateway-url")

    summary = json.loads(Path(args.summary_json).read_text())
    body = render(summary)
    if args.output_textfile:
        output = Path(args.output_textfile)
        output.parent.mkdir(parents=True, exist_ok=True)
        temp = output.with_suffix(output.suffix + ".tmp")
        temp.write_text(body)
        temp.replace(output)
        print(json.dumps({"published": "textfile", "path": str(output)}))
        return

    token = Path(args.bearer_token_file).read_text().strip() if args.bearer_token_file else None
    post_pushgateway(args.pushgateway_url, body, token)
    print(json.dumps({"published": "pushgateway", "url": args.pushgateway_url}))


if __name__ == "__main__":
    main()
