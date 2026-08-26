import importlib.util
from pathlib import Path


SCRIPT = Path(__file__).parents[2] / "scripts" / "infra" / "report_retention_pool_saturation_chaos.py"
spec = importlib.util.spec_from_file_location("chaos_report", SCRIPT)
chaos_report = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(chaos_report)


def test_junit_status_reads_passing_test(tmp_path):
    report = tmp_path / "junit.xml"
    report.write_text('<testsuite tests="1" failures="0" errors="0" skipped="0"><testcase name="pool" /></testsuite>')
    assert chaos_report.junit_status(report) == {"tests": 1, "failures": 0, "errors": 0, "skipped": 0}


def test_junit_status_detects_failed_test(tmp_path):
    report = tmp_path / "junit.xml"
    report.write_text('<testsuite tests="1" failures="1" errors="0" skipped="0"><testcase name="pool"><failure /></testcase></testsuite>')
    result = chaos_report.junit_status(report)
    assert result["tests"] == 1
    assert result["failures"] == 1
