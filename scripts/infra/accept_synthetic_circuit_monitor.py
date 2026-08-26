#!/usr/bin/env python3
"""Acceptance test for worker-metric state changes reaching the synthetic monitor.

This starts an in-process HTTP fixture that emulates the retention worker `/metrics`
endpoint. It deliberately changes the worker circuit state from closed to open,
then verifies the monitor's own Prometheus gauges without contacting a real worker.
"""
from __future__ import annotations

import re
import sys
import threading
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import ClassVar

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from prometheus_client import generate_latest

from simulators.retention_gateway.synthetic_circuit_monitor import SyntheticCircuitMonitor


class WorkerFixture(BaseHTTPRequestHandler):
    snapshot: ClassVar[int] = 0
    payloads: ClassVar[list[str]] = [
        '''# HELP umoja_retention_worker_db_circuit_state state
umoja_retention_worker_db_circuit_state 0
umoja_retention_worker_requests_total{operation="delete"} 20
umoja_retention_worker_results_total{result="database_connection_pool_saturated"} 1
umoja_retention_worker_results_total{result="database_circuit_open"} 0
''',
        '''# HELP umoja_retention_worker_db_circuit_state state
umoja_retention_worker_db_circuit_state 1
umoja_retention_worker_requests_total{operation="delete"} 24
umoja_retention_worker_results_total{result="database_connection_pool_saturated"} 2
umoja_retention_worker_results_total{result="database_circuit_open"} 3
''',
    ]

    def do_GET(self) -> None:  # noqa: N802 - HTTP handler contract
        if self.path != "/metrics":
            self.send_error(404)
            return
        body = self.payloads[self.snapshot].encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; version=0.0.4")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args) -> None:
        return


def metric_value(metrics: str, name: str) -> float:
    match = re.search(rf"^{re.escape(name)}\s+([0-9.]+)$", metrics, flags=re.MULTILINE)
    if not match:
        raise AssertionError(f"missing metric {name}")
    return float(match.group(1))


def main() -> None:
    WorkerFixture.snapshot = 0
    server = ThreadingHTTPServer(("127.0.0.1", 0), WorkerFixture)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        host, port = server.server_address
        monitor = SyntheticCircuitMonitor(f"http://{host}:{port}/metrics", timeout_seconds=2)
        initial = monitor.probe_once()
        assert initial.circuit_state == 0
        assert initial.responses_503 == 1

        WorkerFixture.snapshot = 1
        changed = monitor.probe_once()
        assert changed.circuit_state == 1
        assert changed.responses_503 == 5

        metrics = generate_latest().decode()
        assert metric_value(metrics, "umoja_retention_synthetic_observed_circuit_state") == 1
        # Delta: 4 new requests and 4 new HTTP-503-class results => 100% error rate.
        assert metric_value(metrics, "umoja_retention_synthetic_http_503_rate") == 1
        assert metric_value(metrics, "umoja_retention_synthetic_probe_success") == 1
        print("synthetic circuit monitor acceptance: passed")
    finally:
        server.shutdown()
        server.server_close()


if __name__ == "__main__":
    main()
