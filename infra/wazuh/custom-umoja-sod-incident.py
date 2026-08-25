#!/usr/bin/env python3
"""Bounded Wazuh integration for SoD incident notification.

Usage from Wazuh manager integration:
  custom-umoja-sod-incident.py <alert-json-file>

The endpoint and HMAC secret are supplied only through the manager environment.
This handler creates an incident notification; it never changes UmojaFlowOS state.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import ssl
import sys
import urllib.error
import urllib.request

ALLOWED_RULE_IDS = {"100810", "100811", "100812"}
MAX_ALERT_BYTES = 262_144
TIMEOUT_SECONDS = 5


def fail(reason: str) -> int:
    print(f"umoja_sod_integration_error={reason}", file=sys.stderr)
    return 1


def main() -> int:
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


if __name__ == "__main__":
    raise SystemExit(main())
