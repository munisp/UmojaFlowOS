#!/usr/bin/env python3
"""Convert a weekly-summary.json artifact into a concise executive deck outline.

This creates Markdown slide content from actual report values. It does not create
or infer a data point where the weekly summary has no samples.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path


def metric_text(summary: dict, metric: str, statistic: str) -> str:
    details = summary.get("metrics", {}).get(metric, {})
    value = details.get("statistics", {}).get(statistic)
    unit = details.get("unit", "")
    if value is None:
        return "No samples reported"
    return f"{float(value):.3f} {unit}"


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--summary-json", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()

    summary = json.loads(Path(args.summary_json).read_text())
    generated = summary.get("generated_at", "unknown")
    start = summary.get("window_start", "unknown")
    end = summary.get("window_end", "unknown")
    errors = summary.get("query_errors", {})

    slides = [
        "# UmojaFlowOS Retention Worker Weekly Regression Review",
        "",
        "## Cover",
        "UmojaFlowOS Retention Worker Weekly Regression Review",
        f"Reporting window: {start} to {end}",
        "",
        "## Slide 1 — Executive readout",
        f"Report generated: {generated}",
        f"Prometheus query errors: {len(errors)}",
        "No-sample metrics are explicitly retained as unavailable rather than interpreted as healthy.",
        "",
        "## Slide 2 — Latency trend",
        f"Unique-digest p95: {metric_text(summary, 'unique_locust_p95_seconds', 'p95')}",
        f"Single-digest contention p95: {metric_text(summary, 'contention_locust_p95_seconds', 'p95')}",
        "Compare each value to the five-second operational alert threshold.",
        "",
        "## Slide 3 — Throughput and lock pressure",
        f"Unique-digest mean request rate: {metric_text(summary, 'unique_requests_per_second', 'mean')}",
        f"Contention mean request rate: {metric_text(summary, 'contention_requests_per_second', 'mean')}",
        f"Maximum PostgreSQL lock wait: {metric_text(summary, 'postgres_max_lock_wait_seconds', 'maximum')}",
        f"Maximum waiting sessions: {metric_text(summary, 'postgres_lock_waiting_sessions', 'maximum')}",
        "",
        "## Slide 4 — Security and decision gates",
        f"Maximum security-failure rate: {metric_text(summary, 'security_failures_per_second', 'maximum')}",
        "Do not promote a capacity change if any security-failure value is nonzero, authorization outcomes are ambiguous, or lock waits exceed two seconds.",
        "",
        "## Slide 5 — Recommended action",
        "Approve only a configuration that meets latency, lock-wait, integrity, and security gates under the same image digest and test profile.",
        "Archive the weekly JSON and Markdown artifacts with deployment and database configuration evidence.",
        "",
    ]
    if errors:
        slides.extend(["## Appendix — Data-quality exceptions", *[f"- {name}: {error}" for name, error in sorted(errors.items())], ""])
    Path(args.output).write_text("\n".join(slides))


if __name__ == "__main__":
    main()
