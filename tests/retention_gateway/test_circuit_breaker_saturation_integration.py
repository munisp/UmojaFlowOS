"""Integration tests for fail-closed circuit behavior around the retention delete worker."""
from __future__ import annotations

import os
import threading
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

os.environ["RETENTION_WORKER_IMPORT_ONLY"] = "1"

from simulators.retention_gateway.decision_engine import DeleteRequest, HMACAuthorizationSigner
from simulators.retention_gateway.delete_worker import (
    DatabaseConnectionPoolError,
    DeleteWorker,
    HMACAuthorizationVerifier,
)
from simulators.retention_gateway.worker_service import DatabasePoolCircuitBreaker


NOW = datetime(2026, 8, 25, 12, 0, tzinfo=timezone.utc)
SECRET = b"c" * 32


class MissingIndexOpenSearch:
    """Synthetic target: valid authorization reaches no deletion-capable index."""

    def __init__(self):
        self.identity_calls = 0
        self.delete_calls = 0

    def identity(self, index):
        self.identity_calls += 1
        return None

    def delete_exact_index(self, index, expected_uuid, expected_version):
        self.delete_calls += 1
        raise AssertionError("no delete should be attempted for a synthetic missing index")


class SaturatingThenHealthyStore:
    def __init__(self, failures: int):
        self.failures = failures
        self.calls = 0
        self.lock = threading.Lock()
        self.claimed = set()

    def claim(self, decision_digest, expires_at, now):
        with self.lock:
            self.calls += 1
            if self.calls <= self.failures:
                raise DatabaseConnectionPoolError("simulated pool acquisition timeout")
            if decision_digest in self.claimed:
                return False
            self.claimed.add(decision_digest)
            return True


def request(sequence: int) -> DeleteRequest:
    return DeleteRequest(
        index=f"umoja-synthetic-missing-{sequence}",
        index_uuid=f"uuid-{sequence}",
        index_version="1",
        expected_digest=f"{sequence:064x}",
        requested_by="circuit-integration-test",
        correlation_id=f"circuit-{sequence}",
    )


def execute_with_circuit(worker, circuit, signer, sequence, now):
    req = request(sequence)
    digest = f"{sequence + 1000:064x}"
    token = signer.sign(req, digest, now + timedelta(minutes=5))
    if not circuit.allow(now):
        return "database_circuit_open"
    result = worker.execute(token, req, digest, now)
    if result == "database_connection_pool_saturated":
        circuit.record_pool_saturation(now)
    elif result not in {"database_circuit_open", "database_claim_error"}:
        circuit.record_success()
    return result


def test_saturation_opens_circuit_then_rejects_requests_without_open_search_access():
    store = SaturatingThenHealthyStore(failures=3)
    opensearch = MissingIndexOpenSearch()
    worker = DeleteWorker(HMACAuthorizationVerifier(SECRET), store, opensearch)
    circuit = DatabasePoolCircuitBreaker(failure_threshold=3, reset_seconds=30)
    signer = HMACAuthorizationSigner(SECRET)

    assert [execute_with_circuit(worker, circuit, signer, item, NOW) for item in range(3)] == [
        "database_connection_pool_saturated",
        "database_connection_pool_saturated",
        "database_connection_pool_saturated",
    ]
    assert circuit.state_value == 1
    assert execute_with_circuit(worker, circuit, signer, 3, NOW + timedelta(seconds=1)) == "database_circuit_open"
    assert store.calls == 3
    assert opensearch.identity_calls == 0
    assert opensearch.delete_calls == 0


def test_half_open_success_closes_circuit_and_allows_fail_closed_missing_index_outcome():
    store = SaturatingThenHealthyStore(failures=1)
    opensearch = MissingIndexOpenSearch()
    worker = DeleteWorker(HMACAuthorizationVerifier(SECRET), store, opensearch)
    circuit = DatabasePoolCircuitBreaker(failure_threshold=1, reset_seconds=10)
    signer = HMACAuthorizationSigner(SECRET)

    assert execute_with_circuit(worker, circuit, signer, 1, NOW) == "database_connection_pool_saturated"
    assert circuit.state_value == 1
    assert execute_with_circuit(worker, circuit, signer, 2, NOW + timedelta(seconds=5)) == "database_circuit_open"
    assert execute_with_circuit(worker, circuit, signer, 3, NOW + timedelta(seconds=10)) == "already_deleted"
    assert circuit.state_value == 0
    assert opensearch.identity_calls == 1
    assert opensearch.delete_calls == 0


def test_parallel_saturation_followed_by_probe_wave_never_reaches_delete():
    store = SaturatingThenHealthyStore(failures=20)
    opensearch = MissingIndexOpenSearch()
    worker = DeleteWorker(HMACAuthorizationVerifier(SECRET), store, opensearch)
    circuit = DatabasePoolCircuitBreaker(failure_threshold=3, reset_seconds=30)
    signer = HMACAuthorizationSigner(SECRET)
    barrier = threading.Barrier(12)

    def saturated_request(sequence):
        barrier.wait(timeout=5)
        return execute_with_circuit(worker, circuit, signer, sequence, NOW)

    with ThreadPoolExecutor(max_workers=12) as executor:
        first_wave = list(executor.map(saturated_request, range(12)))

    assert all(result in {"database_connection_pool_saturated", "database_circuit_open"} for result in first_wave)
    assert "database_connection_pool_saturated" in first_wave
    assert circuit.state_value == 1
    probe = [execute_with_circuit(worker, circuit, signer, number, NOW + timedelta(seconds=1)) for number in (20, 21)]
    assert probe == ["database_circuit_open", "database_circuit_open"]
    assert opensearch.identity_calls == 0
    assert opensearch.delete_calls == 0
