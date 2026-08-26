from __future__ import annotations

from unittest.mock import Mock, patch

import pytest
import requests

from simulators.retention_gateway.synthetic_circuit_monitor import (
    SyntheticCircuitMonitor,
    parse_worker_snapshot,
)


def worker_metrics(circuit: int, total: int, saturated: int, open_rejections: int) -> str:
    return f'''\
umoja_retention_worker_db_circuit_state {circuit}
umoja_retention_worker_requests_total{{operation="delete"}} {total}
umoja_retention_worker_results_total{{result="database_connection_pool_saturated"}} {saturated}
umoja_retention_worker_results_total{{result="database_circuit_open"}} {open_rejections}
umoja_retention_worker_results_total{{result="already_deleted"}} 9
'''


def response(metrics: str) -> Mock:
    result = Mock()
    result.text = metrics
    result.raise_for_status.return_value = None
    return result


def test_parses_circuit_state_and_503_result_counters():
    snapshot = parse_worker_snapshot(worker_metrics(circuit=1, total=30, saturated=4, open_rejections=3))
    assert snapshot.circuit_state == 1
    assert snapshot.responses_total == 30
    assert snapshot.responses_503 == 7


def test_computes_delta_based_503_rate_from_two_snapshots():
    monitor = SyntheticCircuitMonitor("http://worker/metrics", timeout_seconds=1)
    first = response(worker_metrics(circuit=0, total=100, saturated=2, open_rejections=1))
    second = response(worker_metrics(circuit=1, total=120, saturated=5, open_rejections=4))
    with patch("simulators.retention_gateway.synthetic_circuit_monitor.requests.get", side_effect=[first, second]):
        monitor.probe_once()
        monitor.probe_once()
    # (5 + 4 - 2 - 1) / (120 - 100) == 6 / 20
    from simulators.retention_gateway.synthetic_circuit_monitor import http_503_rate
    assert http_503_rate._value.get() == pytest.approx(0.3)


def test_missing_circuit_state_is_a_failed_probe():
    monitor = SyntheticCircuitMonitor("http://worker/metrics", timeout_seconds=1)
    missing = response('umoja_retention_worker_requests_total{operation="delete"} 1\n')
    with patch("simulators.retention_gateway.synthetic_circuit_monitor.requests.get", return_value=missing):
        with pytest.raises(ValueError, match="missing required metric"):
            monitor.probe_once()


def test_network_error_is_propagated_for_liveness_and_error_metrics():
    monitor = SyntheticCircuitMonitor("http://worker/metrics", timeout_seconds=1)
    with patch(
        "simulators.retention_gateway.synthetic_circuit_monitor.requests.get",
        side_effect=requests.ConnectionError("worker unavailable"),
    ):
        with pytest.raises(requests.ConnectionError):
            monitor.probe_once()
