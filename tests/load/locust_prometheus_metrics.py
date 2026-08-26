"""Opt-in Prometheus metrics exporter for the retention-worker Locust test.

Set LOCUST_PROMETHEUS_PORT (for example, 9646) on the Locust master or
standalone runner. Do not set it on distributed Locust workers.
"""
from __future__ import annotations

import os

from locust import events
from prometheus_client import Counter, Gauge, Histogram, start_http_server

REQUESTS = Counter(
    "umoja_locust_requests_total",
    "Locust requests issued to the retention worker",
    ["scenario", "request_name", "outcome"],
)
LATENCY = Histogram(
    "umoja_locust_request_duration_seconds",
    "Locust request duration to the retention worker",
    ["scenario", "request_name"],
)
ACTIVE_USERS = Gauge("umoja_locust_active_users", "Active Locust users")
TEST_RUNNING = Gauge("umoja_locust_test_running", "Whether Locust test execution is active")

EXPORTER_STARTED = False


def scenario() -> str:
    return os.getenv("LOCUST_SCENARIO", "unique")


@events.init.add_listener
def configure_metrics(environment, **_kwargs):
    global EXPORTER_STARTED
    port = os.getenv("LOCUST_PROMETHEUS_PORT")
    runner_name = type(environment.runner).__name__ if environment.runner else ""
    if not port or EXPORTER_STARTED or runner_name == "WorkerRunner":
        return
    start_http_server(int(port))
    EXPORTER_STARTED = True


@events.request.add_listener
def record_request(request_type, name, response_time, exception, **_kwargs):
    outcome = "failure" if exception else "success"
    REQUESTS.labels(scenario(), name, outcome).inc()
    LATENCY.labels(scenario(), name).observe(response_time / 1000)


@events.spawning_complete.add_listener
def record_active_users(user_count, **_kwargs):
    ACTIVE_USERS.set(user_count)


@events.test_start.add_listener
def record_test_start(**_kwargs):
    TEST_RUNNING.set(1)


@events.test_stop.add_listener
def record_test_stop(**_kwargs):
    TEST_RUNNING.set(0)
    ACTIVE_USERS.set(0)
