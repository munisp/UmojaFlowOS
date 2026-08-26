import importlib.util
from pathlib import Path


MODULE_PATH = Path(__file__).parents[2] / "scripts" / "infra" / "report_retention_worker_prometheus_weekly.py"
spec = importlib.util.spec_from_file_location("weekly_report", MODULE_PATH)
weekly_report = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(weekly_report)


def test_summarize_empty_series_is_explicit():
    assert weekly_report.summarize([]) == {
        "samples": 0,
        "minimum": None,
        "mean": None,
        "median": None,
        "p95": None,
        "maximum": None,
    }


def test_summarize_calculates_percentile_without_fabrication():
    summary = weekly_report.summarize([1.0, 2.0, 3.0, 4.0, 5.0])
    assert summary["samples"] == 5
    assert summary["minimum"] == 1.0
    assert summary["mean"] == 3.0
    assert summary["median"] == 3.0
    assert summary["p95"] == 4.8
    assert summary["maximum"] == 5.0


def test_markdown_marks_absent_series_as_no_samples():
    empty = weekly_report.summarize([])
    result = {
        "metrics": {
            "unique_requests_per_second": {"unit": "req/s", "statistics": empty},
        }
    }
    rendered = weekly_report.markdown(
        result,
        weekly_report.datetime(2026, 1, 1, tzinfo=weekly_report.timezone.utc),
        weekly_report.datetime(2026, 1, 8, tzinfo=weekly_report.timezone.utc),
    )
    assert "no samples" in rendered
    assert "not interpreted as a healthy value" in rendered
