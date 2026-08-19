"""Regressions for the reporting service's metrics endpoint.

The endpoint is only worth anything if its numbers are measurements. Each test
drives real requests through the ASGI application and then requires the
counters to reflect exactly that traffic, so an implementation returning
plausible constants would fail.
"""

from __future__ import annotations

import importlib

import pytest
from fastapi.testclient import TestClient


@pytest.fixture()
def client() -> TestClient:
    # The module holds process-wide counters, so it is reloaded per test to
    # give each one a service that has served nothing.
    module = importlib.reload(importlib.import_module("umojaflowos_reporting.service"))
    return TestClient(module.app)


def test_metrics_identify_the_service_and_start_at_zero(client: TestClient) -> None:
    payload = client.get("/v1/metrics").json()
    assert payload["service"] == "reporting-analytics"
    assert payload["language"] == "python"
    assert payload["requests_total"] == 0
    assert payload["reports_assembled"] == 0
    # An observation time is required so a stale reading is visibly stale.
    assert payload["observed_at"].endswith("Z")


def test_metrics_count_every_served_request(client: TestClient) -> None:
    for _ in range(3):
        client.get("/healthz")
    payload = client.get("/v1/metrics").json()
    assert payload["requests_total"] == 3


def test_reading_metrics_does_not_inflate_the_metrics(client: TestClient) -> None:
    # Polling the dashboard must not change what the dashboard reports.
    client.get("/healthz")
    for _ in range(4):
        client.get("/v1/metrics")
    payload = client.get("/v1/metrics").json()
    assert payload["requests_total"] == 1


def test_rejected_requests_are_distinguished_from_failures(client: TestClient) -> None:
    # A malformed body is the caller's error, not the service's, and the two
    # must not be collapsed: they call for different operational responses.
    response = client.post("/v1/reports/assemble", json={"regulator": "CBN"})
    assert response.status_code in (422, 400)
    payload = client.get("/v1/metrics").json()
    assert payload["requests_total"] == 1
    assert payload["requests_rejected"] == 1
    assert payload["requests_failed"] == 0


def test_assembled_reports_are_counted_only_on_success(client: TestClient) -> None:
    # A rejected assembly must not count as an assembled report.
    client.post("/v1/reports/assemble", json={"regulator": "CBN"})
    payload = client.get("/v1/metrics").json()
    assert payload["reports_assembled"] == 0


def test_metrics_restate_that_submission_is_disabled(client: TestClient) -> None:
    payload = client.get("/v1/metrics").json()
    assert payload["regulatory_submission"] == "disabled_without_verified_channel"
