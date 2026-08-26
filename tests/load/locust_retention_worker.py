"""Locust benchmark for retention worker PostgreSQL authorization claims.

Set RETENTION_WORKER_LOADTEST_FIXTURE to a fixture produced by
prepare_retention_worker_lock_loadtest.py. Set LOCUST_SCENARIO to `unique`
or `contention`.
"""
from __future__ import annotations

import json
import os
from collections import deque
from pathlib import Path

from gevent.lock import Semaphore
from locust import HttpUser, between, task

# Registers the optional LOCUST_PROMETHEUS_PORT exporter listeners.
from tests.load import locust_prometheus_metrics  # noqa: F401


fixture_path = Path(os.environ["RETENTION_WORKER_LOADTEST_FIXTURE"])
fixture = json.loads(fixture_path.read_text())
unique_payloads = deque(fixture["unique_payloads"])
payload_lock = Semaphore()
scenario = os.getenv("LOCUST_SCENARIO", "unique")
worker_bearer_token = os.environ["RETENTION_WORKER_BEARER_TOKEN"]


class RetentionWorkerLockUser(HttpUser):
    wait_time = between(0.01, 0.05)

    def on_start(self):
        self.headers = {
            "Authorization": f"Bearer {worker_bearer_token}",
            "Content-Type": "application/json",
        }

    @staticmethod
    def next_unique_payload():
        with payload_lock:
            if not unique_payloads:
                return None
            return unique_payloads.popleft()

    def execute(self, payload: dict[str, str], expected_statuses: set[str], request_name: str):
        with self.client.post(
            "/v1/worker/delete",
            json=payload,
            headers=self.headers,
            name=request_name,
            catch_response=True,
        ) as response:
            try:
                result = response.json().get("status") if response.status_code < 400 else response.json().get("detail")
            except ValueError:
                result = None
            if result in expected_statuses:
                response.success()
            else:
                response.failure(f"unexpected status={response.status_code} result={result}")

    @task
    def authorization_claim(self):
        if scenario == "contention":
            self.execute(
                fixture["contention_payload"],
                {"already_deleted", "denied_replay_or_consumed"},
                "claim-contention-single-digest",
            )
            return

        payload = self.next_unique_payload()
        if payload is None:
            self.environment.runner.quit()
            return
        self.execute(payload, {"already_deleted"}, "claim-unique-digest")
