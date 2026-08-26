import os
from datetime import datetime, timedelta, timezone

os.environ["RETENTION_WORKER_IMPORT_ONLY"] = "1"
from simulators.retention_gateway.worker_service import DatabasePoolCircuitBreaker


NOW = datetime(2026, 8, 25, 12, 0, tzinfo=timezone.utc)


def test_pool_circuit_opens_after_threshold_and_rejects_immediately():
    circuit = DatabasePoolCircuitBreaker(failure_threshold=3, reset_seconds=30)
    assert circuit.allow(NOW)
    circuit.record_pool_saturation(NOW)
    circuit.record_pool_saturation(NOW + timedelta(seconds=1))
    assert circuit.state_value == 0
    circuit.record_pool_saturation(NOW + timedelta(seconds=2))
    assert circuit.state_value == 1
    assert not circuit.allow(NOW + timedelta(seconds=3))


def test_pool_circuit_transitions_to_half_open_then_closes_after_success():
    circuit = DatabasePoolCircuitBreaker(failure_threshold=1, reset_seconds=10)
    circuit.record_pool_saturation(NOW)
    assert circuit.state_value == 1
    assert not circuit.allow(NOW + timedelta(seconds=9))
    assert circuit.allow(NOW + timedelta(seconds=10))
    assert circuit.state_value == 2
    circuit.record_success()
    assert circuit.state_value == 0
    assert circuit.allow(NOW + timedelta(seconds=11))


def test_failed_half_open_probe_reopens_circuit():
    circuit = DatabasePoolCircuitBreaker(failure_threshold=1, reset_seconds=10)
    circuit.record_pool_saturation(NOW)
    assert circuit.allow(NOW + timedelta(seconds=10))
    circuit.record_pool_saturation(NOW + timedelta(seconds=10))
    assert circuit.state_value == 1
    assert not circuit.allow(NOW + timedelta(seconds=11))
