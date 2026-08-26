"""Read-only synthetic monitor for retention-worker circuit-breaker telemetry.

The monitor only fetches the worker's Prometheus `/metrics` endpoint. It never
calls the deletion API, issues authorization tokens, or changes worker state.
"""
from __future__ import annotations

import os
import signal
import time
from dataclasses import dataclass
from threading import Event
from typing import Iterable

import requests
from prometheus_client import Counter, Gauge, start_http_server


WORKER_CIRCUIT_STATE = "umoja_retention_worker_db_circuit_state"
WORKER_REQUESTS_TOTAL = "umoja_retention_worker_requests_total"
WORKER_RESULTS_TOTAL = "umoja_retention_worker_results_total"
HTTP_503_RESULTS = {
    "database_connection_pool_saturated",
    "database_claim_error",
    "database_circuit_open",
}

probe_success = Gauge(
    "umoja_retention_synthetic_probe_success",
    "Whether the most recent read-only retention worker metrics probe succeeded.",
)
probe_latency_seconds = Gauge(
    "umoja_retention_synthetic_probe_latency_seconds",
    "Latency of the most recent retention worker metrics request.",
)
probe_failures_total = Counter(
    "umoja_retention_synthetic_probe_failures_total",
    "Total retention worker metrics probe failures.",
)
observed_circuit_state = Gauge(
    "umoja_retention_synthetic_observed_circuit_state",
    "Circuit breaker state observed through the retention worker metrics endpoint.",
)
http_503_rate = Gauge(
    "umoja_retention_synthetic_http_503_rate",
    "Delta-based ratio of retention worker HTTP 503 responses over total observed HTTP responses.",
)
http_503_total = Gauge(
    "umoja_retention_synthetic_http_503_total",
    "Total HTTP 503 responses observed in the current retention worker request counter snapshot.",
)
request_total = Gauge(
    "umoja_retention_synthetic_http_requests_total",
    "Total HTTP responses observed in the current retention worker request counter snapshot.",
)


@dataclass(frozen=True)
class Snapshot:
    circuit_state: float
    responses_total: float
    responses_503: float


def _metric_samples(text: str, metric_name: str) -> Iterable[tuple[dict[str, str], float]]:
    """Parse Prometheus exposition lines for one metric without external parser state."""
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        head, _, raw_value = line.rpartition(" ")
        if not head or not raw_value:
            continue
        name = head.split("{", 1)[0]
        if name != metric_name:
            continue
        labels: dict[str, str] = {}
        if "{" in head:
            raw_labels = head.split("{", 1)[1].rstrip("}")
            for part in raw_labels.split(","):
                key, sep, value = part.partition("=")
                if sep:
                    labels[key] = value.strip().strip('"')
        try:
            yield labels, float(raw_value)
        except ValueError:
            continue


def parse_worker_snapshot(text: str) -> Snapshot:
    circuit = max((value for _, value in _metric_samples(text, WORKER_CIRCUIT_STATE)), default=float("nan"))
    total = sum(value for _, value in _metric_samples(text, WORKER_REQUESTS_TOTAL))
    failures_503 = sum(
        value
        for labels, value in _metric_samples(text, WORKER_RESULTS_TOTAL)
        if labels.get("result") in HTTP_503_RESULTS
    )
    if circuit != circuit:  # NaN check: absence is a probe failure.
        raise ValueError(f"missing required metric {WORKER_CIRCUIT_STATE}")
    return Snapshot(circuit_state=circuit, responses_total=total, responses_503=failures_503)


class SyntheticCircuitMonitor:
    def __init__(self, worker_metrics_url: str, timeout_seconds: float) -> None:
        if not worker_metrics_url.startswith(("http://", "https://")):
            raise ValueError("RETENTION_WORKER_METRICS_URL must use HTTP or HTTPS")
        self.worker_metrics_url = worker_metrics_url
        self.timeout_seconds = timeout_seconds
        self.previous: Snapshot | None = None

    def probe_once(self) -> Snapshot:
        started = time.monotonic()
        try:
            response = requests.get(self.worker_metrics_url, timeout=self.timeout_seconds)
            response.raise_for_status()
            snapshot = parse_worker_snapshot(response.text)
        except (requests.RequestException, ValueError):
            probe_success.set(0)
            probe_failures_total.inc()
            raise

        probe_success.set(1)
        probe_latency_seconds.set(time.monotonic() - started)
        observed_circuit_state.set(snapshot.circuit_state)
        request_total.set(snapshot.responses_total)
        http_503_total.set(snapshot.responses_503)

        if self.previous is not None:
            total_delta = max(snapshot.responses_total - self.previous.responses_total, 0.0)
            failure_delta = max(snapshot.responses_503 - self.previous.responses_503, 0.0)
            http_503_rate.set(failure_delta / total_delta if total_delta else 0.0)
        self.previous = snapshot
        return snapshot

    def run_forever(self, interval_seconds: float, stop_event: Event) -> None:
        while not stop_event.is_set():
            try:
                self.probe_once()
            except (requests.RequestException, ValueError):
                pass
            stop_event.wait(interval_seconds)


def main() -> None:
    metrics_url = os.environ.get("RETENTION_WORKER_METRICS_URL", "")
    interval = float(os.environ.get("SYNTHETIC_PROBE_INTERVAL_SECONDS", "15"))
    timeout = float(os.environ.get("SYNTHETIC_PROBE_TIMEOUT_SECONDS", "5"))
    exporter_port = int(os.environ.get("SYNTHETIC_PROMETHEUS_PORT", "9468"))
    if interval < 5:
        raise ValueError("SYNTHETIC_PROBE_INTERVAL_SECONDS must be at least 5")
    if timeout <= 0 or timeout >= interval:
        raise ValueError("probe timeout must be positive and less than probe interval")

    stop_event = Event()

    def stop_handler(_signal, _frame) -> None:
        stop_event.set()

    signal.signal(signal.SIGTERM, stop_handler)
    signal.signal(signal.SIGINT, stop_handler)
    start_http_server(exporter_port)
    SyntheticCircuitMonitor(metrics_url, timeout).run_forever(interval, stop_event)


if __name__ == "__main__":
    main()
