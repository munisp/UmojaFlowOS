import importlib.util
import json
import subprocess
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "infra" / "weekly_summary_to_executive_deck.py"


def test_converter_preserves_real_values_and_no_sample_states(tmp_path):
    summary = {
        "generated_at": "2026-08-25T12:00:00+00:00",
        "window_start": "2026-08-18T12:00:00+00:00",
        "window_end": "2026-08-25T12:00:00+00:00",
        "query_errors": {},
        "metrics": {
            "unique_locust_p95_seconds": {"unit": "s", "statistics": {"p95": 1.25}},
            "contention_locust_p95_seconds": {"unit": "s", "statistics": {"p95": None}},
            "unique_requests_per_second": {"unit": "req/s", "statistics": {"mean": 20.0}},
            "contention_requests_per_second": {"unit": "req/s", "statistics": {"mean": 5.0}},
            "postgres_max_lock_wait_seconds": {"unit": "s", "statistics": {"maximum": 0.2}},
            "postgres_lock_waiting_sessions": {"unit": "sessions", "statistics": {"maximum": 1.0}},
            "security_failures_per_second": {"unit": "failures/s", "statistics": {"maximum": 0.0}},
        },
    }
    input_file, output_file = tmp_path / "weekly-summary.json", tmp_path / "deck.md"
    input_file.write_text(json.dumps(summary))
    subprocess.run(["python3", str(SCRIPT), "--summary-json", str(input_file), "--output", str(output_file)], check=True)
    result = output_file.read_text()
    assert "1.250 s" in result
    assert "20.000 req/s" in result
    assert "No samples reported" in result
