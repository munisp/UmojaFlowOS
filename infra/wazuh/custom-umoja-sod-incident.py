#!/usr/bin/env python3
"""Bounded Wazuh integration for SoD incident notification.

Usage from Wazuh manager integration:
  custom-umoja-sod-incident.py <alert-json-file>

The endpoint, HMAC secret, and Prometheus textfile path are supplied only
through the manager environment. This handler creates an incident notification;
it never changes UmojaFlowOS state.
"""
from __future__ import annotations

import fcntl
import hashlib
import hmac
import json
import os
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

ALLOWED_RULE_IDS = {"100810", "100811", "100812", "100820"}
MAX_ALERT_BYTES = 262_144
TIMEOUT_SECONDS = 5
DEFAULT_METRICS_PATH = "/var/lib/node_exporter/textfile_collector/umoja_sod_incident.prom"


def fail(reason: str) -> int:
    print(f"umoja_sod_integration_error={reason}", file=sys.stderr)
    return 1


def _metrics_path() -> Path:
    return Path(os.environ.get("UMOJA_SOD_METRICS_PATH", DEFAULT_METRICS_PATH))


def _write_metrics(duration_seconds: float, success: bool) -> None:
    """Update Prometheus textfile metrics using an exclusive lock and atomic replace."""
    path = _metrics_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        lock_path = path.with_name(f".{path.name}.lock")
        with lock_path.open("a+", encoding="utf-8") as lock:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
            state_path = path.with_name(f".{path.name}.state.json")
            state = {"requests": 0, "successes": 0, "failures": 0, "duration_sum": 0.0}
            try:
                state.update(json.loads(state_path.read_text(encoding="utf-8")))
            except (FileNotFoundError, json.JSONDecodeError, OSError):
                pass
            state["requests"] = int(state["requests"]) + 1
            state["successes"] = int(state["successes"]) + int(success)
            state["failures"] = int(state["failures"]) + int(not success)
            state["duration_sum"] = float(state["duration_sum"]) + duration_seconds
            state_path.write_text(json.dumps(state, sort_keys=True), encoding="utf-8")
            exposition = (
                "# HELP umoja_sod_incident_requests_total Total Wazuh SoD incident-handler invocations.\n"
                "# TYPE umoja_sod_incident_requests_total counter\n"
                f"umoja_sod_incident_requests_total {state['requests']}\n"
                "# HELP umoja_sod_incident_successes_total Successfully delivered incident notifications.\n"
                "# TYPE umoja_sod_incident_successes_total counter\n"
                f"umoja_sod_incident_successes_total {state['successes']}\n"
                "# HELP umoja_sod_incident_failures_total Failed incident-handler invocations.\n"
                "# TYPE umoja_sod_incident_failures_total counter\n"
                f"umoja_sod_incident_failures_total {state['failures']}\n"
                "# HELP umoja_sod_incident_duration_seconds_sum Total handler execution time in seconds.\n"
                "# TYPE umoja_sod_incident_duration_seconds_sum counter\n"
                f"umoja_sod_incident_duration_seconds_sum {state['duration_sum']:.9f}\n"
            )
            fd, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
            try:
                with os.fdopen(fd, "w", encoding="utf-8") as output:
                    output.write(exposition)
                    output.flush()
                    os.fsync(output.fileno())
                os.replace(temporary, path)
            finally:
                if os.path.exists(temporary):
                    os.unlink(temporary)
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    except (OSError, ValueError, TypeError) as exc:
        # Metrics must never turn a valid alert delivery into a failed delivery.
        print(f"umoja_sod_metrics_error={type(exc).__name__}", file=sys.stderr)


def _run() -> int:
    if len(sys.argv) != 2:
        return fail("usage_requires_alert_json_path")
    alert_path = sys.argv[1]
    endpoint = os.environ.get("UMOJA_SOD_INCIDENT_ENDPOINT", "").strip()
    secret_path = os.environ.get("UMOJA_SOD_INCIDENT_HMAC_SECRET_FILE", "").strip()
    if not endpoint.startswith("https://"):
        return fail("https_endpoint_required")
    if not secret_path.startswith("/"):
        return fail("absolute_hmac_secret_file_required")
    try:
        if os.path.getsize(alert_path) > MAX_ALERT_BYTES:
            return fail("alert_too_large")
        with open(alert_path, "rb") as handle:
            raw = handle.read(MAX_ALERT_BYTES + 1)
        alert = json.loads(raw)
        with open(secret_path, "rb") as handle:
            secret = handle.read(4097).rstrip(b"\n")
    except (OSError, ValueError, json.JSONDecodeError) as exc:
        return fail(f"input_read_failed:{type(exc).__name__}")
    if not secret or len(secret) > 4096:
        return fail("invalid_hmac_secret")
    rule_id = str(alert.get("rule", {}).get("id", ""))
    if rule_id not in ALLOWED_RULE_IDS:
        return fail("rule_not_allowlisted")
    data = alert.get("data", {})
    event = data.get("event")
    digest = data.get("exceptionDigest")
    if event in {"sod_monitor_evaluation", "sod_alert_delivery"}:
        if not isinstance(digest, str) or len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            return fail("invalid_exception_digest")
    if rule_id == "100820":
        syscheck = data.get("syscheck", {})
        if syscheck.get("path") != "/var/log/umoja/sod-audit.jsonl":
            return fail("invalid_sod_audit_tamper_path")
    payload = {
        "source": "umoja-flowos",
        "category": "segregation_of_duties",
        "ruleId": rule_id,
        "level": alert.get("rule", {}).get("level"),
        "event": event,
        "evaluationState": data.get("evaluationState"),
        "deliveryState": data.get("deliveryState"),
        "exceptionCount": data.get("exceptionCount"),
        "exceptionDigest": digest,
        "correlationId": data.get("correlationId"),
        "timestamp": alert.get("timestamp"),
    }
    body = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    signature = hmac.new(secret, body, hashlib.sha256).hexdigest()
    request = urllib.request.Request(
        endpoint,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "User-Agent": "umoja-sod-wazuh-integration/1",
            "X-Umoja-Signature": f"sha256={signature}",
        },
    )
    try:
        context = ssl.create_default_context()
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS, context=context) as response:
            if response.status < 200 or response.status >= 300:
                return fail(f"incident_endpoint_status_{response.status}")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        return fail(f"incident_delivery_failed:{type(exc).__name__}")
    print(f"umoja_sod_incident_delivered=1 correlation_id={payload.get('correlationId', '')}")
    return 0


def main() -> int:
    started = time.monotonic()
    result = 1
    try:
        result = _run()
        return result
    finally:
        _write_metrics(time.monotonic() - started, result == 0)


if __name__ == "__main__":
    raise SystemExit(main())
