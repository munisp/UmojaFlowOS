import json
import os
import subprocess
import time
from concurrent.futures import ThreadPoolExecutor
import urllib.error
import urllib.request
from pathlib import Path

import pytest

pytestmark = pytest.mark.chaos

if os.getenv("RUN_CHAOS_MESH") != "1":
    pytest.skip("set RUN_CHAOS_MESH=1 to run Chaos Mesh tests", allow_module_level=True)

ROOT = Path(__file__).parents[2]
MANIFEST_DIR = ROOT / "infra" / "retention-gateway" / "chaos-mesh"
NAMESPACE = os.getenv("CHAOS_NAMESPACE", "security")
WORKER_SELECTOR = "app.kubernetes.io/name=umoja-retention-worker"
MONITOR_SELECTOR = "app.kubernetes.io/name=umoja-retention-synthetic-monitor"


def kubectl(*args, check=True):
    return subprocess.run(["kubectl", *args], check=check, text=True, capture_output=True)


def apply(name):
    kubectl("-n", NAMESPACE, "apply", "-f", str(MANIFEST_DIR / name))


def delete(name):
    kubectl("-n", NAMESPACE, "delete", "-f", str(MANIFEST_DIR / name), "--ignore-not-found", check=False)


def trigger_worker_execution():
    url = os.environ["WORKER_SERVICE_URL"].rstrip("/") + "/v1/worker/delete"
    payload = os.environ["WORKER_DELETE_PAYLOAD"].encode()
    request = urllib.request.Request(
        url,
        data=payload,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + os.environ["WORKER_BEARER_TOKEN"],
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=15) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def trigger_worker_execution_payload(payload):
    url = os.environ["WORKER_SERVICE_URL"].rstrip("/") + "/v1/worker/delete"
    request = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + os.environ["WORKER_BEARER_TOKEN"],
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read().decode()
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode()


def monitor_metric(metric):
    metrics_url = os.environ.get("SYNTHETIC_MONITOR_METRICS_URL")
    if not metrics_url:
        pytest.skip("SYNTHETIC_MONITOR_METRICS_URL is required for synthetic-monitor latency validation")
    with urllib.request.urlopen(metrics_url, timeout=15) as response:
        return "\n".join(line for line in response.read().decode().splitlines() if line.startswith(metric))


def worker_metric(metric):
    metrics_url = os.getenv("WORKER_METRICS_URL")
    if metrics_url:
        with urllib.request.urlopen(metrics_url, timeout=15) as response:
            return "\n".join(line for line in response.read().decode().splitlines() if line.startswith(metric))
    pod = kubectl("-n", NAMESPACE, "get", "pods", "-l", WORKER_SELECTOR, "-o", "jsonpath={.items[0].metadata.name}").stdout
    result = kubectl("-n", NAMESPACE, "exec", pod, "--", "sh", "-c", f"wget -qO- http://127.0.0.1:8080/metrics | grep '^{metric}' || true")
    return result.stdout


def test_certificate_expiry_clock_skew_is_fail_closed():
    apply("timechaos-worker-cert-expiry.yaml")
    try:
        time.sleep(int(os.getenv("CHAOS_SETTLE_SECONDS", "20")))
        status, _ = trigger_worker_execution()
        assert status >= 400
        result = kubectl("-n", NAMESPACE, "get", "pods", "-l", WORKER_SELECTOR, "-o", "json")
        pods = json.loads(result.stdout)["items"]
        assert pods
        # The worker should remain running but OpenSearch TLS calls must fail closed.
        metric = worker_metric("umoja_retention_worker_failures_total")
        assert "opensearch_authentication_failure" in metric or "opensearch_authorization_failure" in metric
    finally:
        delete("timechaos-worker-cert-expiry.yaml")
        kubectl("-n", NAMESPACE, "delete", "pod", "-l", WORKER_SELECTOR, "--wait=true", check=False)


def test_postgres_connection_pool_saturation_is_fail_closed():
    payloads_path = os.getenv("WORKER_POOL_SATURATION_PAYLOADS_FILE")
    if payloads_path:
        payloads = json.loads(Path(payloads_path).read_text())["unique_payloads"]
    else:
        payloads = json.loads(os.environ["WORKER_POOL_SATURATION_PAYLOADS"])
    if len(payloads) < 16:
        pytest.fail("WORKER_POOL_SATURATION_PAYLOADS must contain at least 16 distinct synthetic authorizations")
    use_scheduled_fault = os.getenv("CHAOS_USE_SCHEDULED_POOL_FAULT") == "1"
    if not use_scheduled_fault:
        apply("networkchaos-worker-postgres-pool-saturation.yaml")
    try:
        time.sleep(int(os.getenv("CHAOS_SETTLE_SECONDS", "20")))
        initial_wave = payloads[:14]
        probe_wave = payloads[14:16]
        with ThreadPoolExecutor(max_workers=len(initial_wave)) as executor:
            futures = [executor.submit(trigger_worker_execution_payload, payload) for payload in initial_wave]
            # Pool acquisition times out at 2s while the active DB requests are delayed
            # for at least 2.5s. The probe therefore reaches the open breaker before
            # slow in-flight requests can record a successful recovery.
            time.sleep(float(os.getenv("CHAOS_CIRCUIT_PROBE_DELAY_SECONDS", "2.3")))
            probe_responses = [trigger_worker_execution_payload(payload) for payload in probe_wave]
            circuit_metric_while_open = worker_metric("umoja_retention_worker_db_circuit_state")
            responses = [future.result() for future in futures] + probe_responses
        # Synthetic indices are deliberately nonexistent, so successes can only be
        # already_deleted. A pool timeout or open circuit must surface as HTTP 503.
        assert any(status == 503 and "database_connection_pool_saturated" in body for status, body in responses)
        assert any(status == 503 and "database_circuit_open" in body for status, body in probe_responses)
        assert not any("deleted" in body and "already_deleted" not in body for _status, body in responses)
        metric = worker_metric("umoja_retention_worker_failures_total")
        assert "database_connection_pool_saturated" in metric
        assert "database_circuit_open" in metric
        assert any(line.rstrip().endswith(" 1.0") for line in circuit_metric_while_open.splitlines())
        pool_metric = worker_metric("umoja_retention_worker_db_pool_waiting")
        assert pool_metric
    finally:
        if not use_scheduled_fault:
            delete("networkchaos-worker-postgres-pool-saturation.yaml")
        time.sleep(5)


def test_synthetic_monitor_latency_is_detected_without_worker_state_change():
    apply("networkchaos-synthetic-monitor-worker-latency.yaml")
    try:
        # The injected 7s delay exceeds the monitor's 5s timeout. Allow time for
        # at least one 15s probe iteration while the fault remains active.
        time.sleep(int(os.getenv("SYNTHETIC_MONITOR_CHAOS_SETTLE_SECONDS", "25")))
        probe_success = monitor_metric("umoja_retention_synthetic_probe_success")
        probe_failures = monitor_metric("umoja_retention_synthetic_probe_failures_total")
        worker_health = worker_metric("umoja_retention_worker_health")
        worker_circuit = worker_metric("umoja_retention_worker_db_circuit_state")
        assert any(line.rstrip().endswith(" 0.0") for line in probe_success.splitlines())
        assert any(float(line.rsplit(" ", 1)[1]) >= 1 for line in probe_failures.splitlines())
        assert any(line.rstrip().endswith(" 1.0") for line in worker_health.splitlines())
        assert any(line.rstrip().endswith(" 0.0") for line in worker_circuit.splitlines())
    finally:
        delete("networkchaos-synthetic-monitor-worker-latency.yaml")
        time.sleep(5)


def test_mtls_network_partition_does_not_delete_or_bypass_authorization():
    apply("networkchaos-worker-opensearch-partition.yaml")
    try:
        time.sleep(int(os.getenv("CHAOS_SETTLE_SECONDS", "20")))
        status, _ = trigger_worker_execution()
        assert status >= 400
        metric = worker_metric("umoja_retention_worker_failures_total")
        assert "delete_execution_error" in metric or "opensearch_authentication_failure" in metric
        # No direct delete is performed by this test. The assertion is that the
        # worker reports failure while PostgreSQL authorization remains the gate.
    finally:
        delete("networkchaos-worker-opensearch-partition.yaml")
        time.sleep(5)
