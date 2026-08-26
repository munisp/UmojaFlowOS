import importlib.util
from pathlib import Path

import pytest


MODULE_PATH = Path(__file__).parents[2] / "scripts" / "infra" / "publish_retention_weekly_summary_prometheus.py"
spec = importlib.util.spec_from_file_location("weekly_publisher", MODULE_PATH)
weekly_publisher = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(weekly_publisher)


def summary(value):
    return {
        "generated_at": "2026-08-25T12:00:00+00:00",
        "metrics": {
            "unique_locust_p95_seconds": {
                "unit": "s",
                "statistics": {
                    "minimum": 1.0,
                    "mean": value,
                    "median": 2.0,
                    "p95": 3.0,
                    "maximum": 4.0,
                },
            },
            "contention_locust_p95_seconds": {
                "unit": "s",
                "statistics": {
                    "minimum": None,
                    "mean": None,
                    "median": None,
                    "p95": None,
                    "maximum": None,
                },
            },
        },
    }


def test_render_exports_observed_statistics_and_omits_missing_values():
    rendered = weekly_publisher.render(summary(2.5))
    assert 'metric="unique_locust_p95_seconds",statistic="mean",unit="s"} 2.5' in rendered
    assert 'metric="contention_locust_p95_seconds"' not in rendered
    assert "umoja_retention_weekly_report_generated" in rendered


def test_render_rejects_nonfinite_values():
    with pytest.raises(ValueError, match="non-finite"):
        weekly_publisher.render(summary(float("inf")))
