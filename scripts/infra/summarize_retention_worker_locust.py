#!/usr/bin/env python3
"""Compare Locust unique-digest and contention-profile CSV result sets.

Inputs must be Locust CSV prefixes or explicit *_stats.csv paths. The script
writes a machine-readable JSON summary and a Markdown report using only values
present in the Locust output.
"""
from __future__ import annotations

import argparse
import csv
import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


COLUMN_ALIASES = {
    "requests": ("Request Count", "# requests", "Requests"),
    "failures": ("Failure Count", "# failures", "Failures"),
    "rps": ("Requests/s", "Current RPS"),
    "failure_rps": ("Failures/s", "Current Failures/s"),
    "average_ms": ("Average Response Time", "Average response time"),
    "median_ms": ("50%", "Median Response Time", "Median response time"),
    "p95_ms": ("95%", "95% Response Time"),
    "p99_ms": ("99%", "99% Response Time"),
}


def resolve_stats_path(value: str) -> Path:
    path = Path(value)
    candidates = [path]
    if not path.name.endswith(".csv"):
        candidates.extend([Path(f"{value}_stats.csv"), Path(f"{value}-stats.csv")])
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    searched = ", ".join(str(item) for item in candidates)
    raise FileNotFoundError(f"Locust stats CSV not found; searched: {searched}")


def number(row: dict[str, str], aliases: tuple[str, ...]) -> float:
    for name in aliases:
        value = row.get(name)
        if value not in (None, ""):
            return float(value.replace(",", ""))
    return 0.0


def choose_row(rows: list[dict[str, str]], expected_name: str) -> dict[str, str]:
    for row in rows:
        if row.get("Name") == expected_name:
            return row
    for row in rows:
        if row.get("Name") == "Aggregated":
            return row
    if not rows:
        raise ValueError("Locust stats CSV contains no rows")
    return rows[0]


def parse_profile(input_value: str, expected_name: str) -> dict[str, Any]:
    path = resolve_stats_path(input_value)
    with path.open(newline="") as handle:
        rows = list(csv.DictReader(handle))
    row = choose_row(rows, expected_name)
    result = {
        "stats_csv": str(path),
        "request_name": row.get("Name", "unknown"),
        "requests": int(number(row, COLUMN_ALIASES["requests"])),
        "failures": int(number(row, COLUMN_ALIASES["failures"])),
        "requests_per_second": number(row, COLUMN_ALIASES["rps"]),
        "failures_per_second": number(row, COLUMN_ALIASES["failure_rps"]),
        "average_ms": number(row, COLUMN_ALIASES["average_ms"]),
        "median_ms": number(row, COLUMN_ALIASES["median_ms"]),
        "p95_ms": number(row, COLUMN_ALIASES["p95_ms"]),
        "p99_ms": number(row, COLUMN_ALIASES["p99_ms"]),
    }
    result["failure_rate_pct"] = (100 * result["failures"] / result["requests"]) if result["requests"] else 0.0
    return result


def delta_percent(left: float, right: float) -> float | None:
    if left == 0:
        return None
    return ((right - left) / left) * 100


def render_markdown(unique: dict[str, Any], contention: dict[str, Any]) -> str:
    metrics = [
        ("Requests", "requests", "count"),
        ("Failures", "failures", "count"),
        ("Failure rate", "failure_rate_pct", "%"),
        ("Requests/sec", "requests_per_second", "ops/s"),
        ("Average latency", "average_ms", "ms"),
        ("Median latency", "median_ms", "ms"),
        ("p95 latency", "p95_ms", "ms"),
        ("p99 latency", "p99_ms", "ms"),
    ]
    lines = [
        "# Retention Worker Locust Performance Comparison",
        "",
        f"Generated: {datetime.now(timezone.utc).isoformat()}",
        "",
        "This report compares recorded Locust CSV results. It does not infer missing values or treat replay denials as unexpected failures in the contention profile.",
        "",
        "| Metric | Unique-digest profile | Single-digest contention | Change: contention vs unique |",
        "|---|---:|---:|---:|",
    ]
    for label, key, unit in metrics:
        baseline = float(unique[key])
        contender = float(contention[key])
        change = delta_percent(baseline, contender)
        display_change = "n/a" if change is None else f"{change:+.2f}%"
        if unit == "count":
            left, right = f"{int(baseline)}", f"{int(contender)}"
        else:
            left, right = f"{baseline:.2f} {unit}", f"{contender:.2f} {unit}"
        lines.append(f"| {label} | {left} | {right} | {display_change} |")
    lines.extend([
        "",
        "## Interpretation",
        "",
        "The unique-digest profile measures independent authorization claims. The contention profile intentionally reuses one decision digest; exactly one claim may execute while the remaining requests should be rejected as `denied_replay_or_consumed`. Review the worker result counters and PostgreSQL authorization row before using these results as a capacity decision.",
        "",
        "## Source files",
        "",
        f"- Unique: `{unique['stats_csv']}`",
        f"- Contention: `{contention['stats_csv']}`",
        "",
    ])
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--unique", required=True, help="Unique profile CSV prefix or *_stats.csv file")
    parser.add_argument("--contention", required=True, help="Contention profile CSV prefix or *_stats.csv file")
    parser.add_argument("--output-dir", default="/tmp/retention-worker-locust-summary")
    args = parser.parse_args()

    unique = parse_profile(args.unique, "claim-unique-digest")
    contention = parse_profile(args.contention, "claim-contention-single-digest")
    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "unique": unique,
        "contention": contention,
    }
    output = Path(args.output_dir)
    output.mkdir(parents=True, exist_ok=True)
    (output / "summary.json").write_text(json.dumps(summary, indent=2) + "\n")
    (output / "summary.md").write_text(render_markdown(unique, contention))
    print(json.dumps({"output_dir": str(output), "files": ["summary.json", "summary.md"]}))


if __name__ == "__main__":
    main()
