"""Integration tests for the weekly Chaos validation report collector.

A local HTTP fixture simulates Prometheus values observed while the scheduled
NetworkChaos delay is active. No Docker or Kubernetes cluster is required.
"""
from __future__ import annotations

import json
import subprocess
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

import pytest


ROOT = Path(__file__).parents[2]
REPORT_SCRIPT = ROOT / "scripts" / "infra" / "report_retention_pool_saturation_chaos.py"
CRONJOB = ROOT / "infra" / "retention-gateway" / "chaos-mesh" / "weekly-pool-saturation-validation-cronjob.yaml"


class PrometheusFixture(BaseHTTPRequestHandler):
    values = {
        "pool_saturation_failures": "4",
        "max_pool_waiting": "10",
        "max_lock_wait_seconds": "3.2",
        "worker_up": "1",
    }

    def log_message(self, *args):
        return None

    def do_GET(self):
        query = parse_qs(urlparse(self.path).query).get("query", [""])[0]
        if "database_connection_pool_saturated" in query:
            value = self.values["pool_saturation_failures"]
        elif "db_pool_waiting" in query:
            value = self.values["max_pool_waiting"]
        elif "pg_retention_lock_wait" in query:
            value = self.values["max_lock_wait_seconds"]
        elif 'up{job="umoja-retention-worker"}' in query:
            value = self.values["worker_up"]
        else:
            self.send_response(400)
            self.end_headers()
            return
        body = json.dumps({
            "status": "success",
            "data": {"resultType": "vector", "result": [{"metric": {}, "value": [0, value]}]},
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


@pytest.fixture
def prometheus_server():
    server = ThreadingHTTPServer(("127.0.0.1", 0), PrometheusFixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        thread.join()


def junit(path: Path, failures: int = 0) -> None:
    path.write_text(
        f'<testsuite tests="1" failures="{failures}" errors="0" skipped="0">'
        '<testcase name="test_postgres_connection_pool_saturation_is_fail_closed" />'
        "</testsuite>"
    )


def run_report(tmp_path: Path, prometheus_url: str, environment: str = "staging") -> subprocess.CompletedProcess:
    junit_path = tmp_path / "junit.xml"
    junit(junit_path)
    output = tmp_path / "report"
    return subprocess.run(
        [
            "python3", str(REPORT_SCRIPT),
            "--junit", str(junit_path),
            "--prometheus-url", prometheus_url,
            "--environment", environment,
            "--output-dir", str(output),
        ],
        text=True,
        capture_output=True,
    )


def test_weekly_report_parses_active_fault_metrics_and_validates_evidence(tmp_path, prometheus_server):
    result = run_report(tmp_path, prometheus_server)
    assert result.returncode == 0, result.stderr
    report = json.loads((tmp_path / "report" / "chaos-pool-saturation-report.json").read_text())
    assert report["environment"] == "staging"
    assert report["metrics"] == {
        "pool_saturation_failures": 4.0,
        "max_pool_waiting": 10.0,
        "max_lock_wait_seconds": 3.2,
        "worker_up": 1.0,
    }
    assert report["validation"]["passed"] is True
    assert "Validation passed | True" in (tmp_path / "report" / "chaos-pool-saturation-report.md").read_text()


def test_weekly_report_rejects_absent_saturation_evidence(tmp_path, prometheus_server):
    original = PrometheusFixture.values["pool_saturation_failures"]
    PrometheusFixture.values["pool_saturation_failures"] = "0"
    try:
        result = run_report(tmp_path, prometheus_server)
    finally:
        PrometheusFixture.values["pool_saturation_failures"] = original
    assert result.returncode == 1
    report = json.loads((tmp_path / "report" / "chaos-pool-saturation-report.json").read_text())
    assert report["validation"]["pool_saturation_observed"] is False


def test_weekly_report_rejects_non_staging_target(tmp_path, prometheus_server):
    result = run_report(tmp_path, prometheus_server, environment="production")
    assert result.returncode == 1
    report = json.loads((tmp_path / "report" / "chaos-pool-saturation-report.json").read_text())
    assert report["validation"]["staging_target"] is False


def test_weekly_cronjob_is_bound_to_staging_and_report_runner():
    text = CRONJOB.read_text()
    assert 'value: staging' in text
    assert 'command: ["/app/run_weekly_pool_saturation.sh"]' in text
    assert 'schedule: "2 3 * * 0"' in text
    assert 'umoja-retention-chaos-reports' in text
