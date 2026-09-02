#!/usr/bin/env python3
"""Validate an Alertmanager -> Novu webhook transformation without network calls."""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any

SENSITIVE = re.compile(r"(token|secret|password|authorization|credential|payload|document|account|iban|phone|email|address|kyc)", re.I)
REQUIRED_ALERT_KEYS = {"status", "labels", "annotations", "startsAt", "fingerprint"}
ALLOWED_STATUS = {"firing", "resolved"}
ROLES = {"critical": "critical-compliance", "warning": "compliance-warning", "info": "compliance-info"}


def scrub(value: Any) -> Any:
    if isinstance(value, dict):
        return {k: scrub(v) for k, v in value.items() if not SENSITIVE.search(k)}
    if isinstance(value, list):
        return [scrub(v) for v in value]
    return value


def require_string(mapping: dict[str, Any], key: str, context: str) -> str:
    value = mapping.get(key)
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{context}.{key} must be a non-empty string")
    return value


def transform(payload: dict[str, Any], workflow_prefix: str = "umoja-compliance") -> dict[str, Any]:
    if not isinstance(payload, dict):
        raise ValueError("root payload must be an object")
    receiver = require_string(payload, "receiver", "root")
    status = require_string(payload, "status", "root")
    if status not in ALLOWED_STATUS:
        raise ValueError("root.status must be firing or resolved")
    alerts = payload.get("alerts")
    if not isinstance(alerts, list) or not alerts:
        raise ValueError("root.alerts must be a non-empty array")

    transformed: list[dict[str, Any]] = []
    severities: set[str] = set()
    tenant_ids: set[str] = set()
    for index, alert in enumerate(alerts):
        if not isinstance(alert, dict) or not REQUIRED_ALERT_KEYS.issubset(alert):
            raise ValueError(f"alerts[{index}] is missing required Alertmanager fields")
        alert_status = require_string(alert, "status", f"alerts[{index}]")
        if alert_status not in ALLOWED_STATUS:
            raise ValueError(f"alerts[{index}].status is invalid")
        labels = alert["labels"]
        annotations = alert["annotations"]
        if not isinstance(labels, dict) or not isinstance(annotations, dict):
            raise ValueError(f"alerts[{index}] labels and annotations must be objects")
        name = require_string(labels, "alertname", f"alerts[{index}].labels")
        tenant_id = labels.get("tenant_id")
        if not isinstance(tenant_id, str) or not tenant_id.strip():
            raise ValueError(f"alerts[{index}].labels.tenant_id must be a non-empty string")
        tenant_ids.add(tenant_id)
        severity = str(labels.get("severity", "warning"))
        if severity not in ROLES:
            raise ValueError(f"alerts[{index}] unsupported severity: {severity}")
        fingerprint = require_string(alert, "fingerprint", f"alerts[{index}]")
        summary = require_string(annotations, "summary", f"alerts[{index}].annotations")
        description = str(annotations.get("description", ""))
        severities.add(severity)
        transformed.append({
            "alertname": name,
            "severity": severity,
            "status": alert_status,
            "fingerprint": fingerprint,
            "summary": summary,
            "description": description,
            "labels": scrub(labels),
            "annotations": scrub(annotations),
        })

    if len(tenant_ids) != 1:
        raise ValueError("alerts must contain exactly one tenant_id for isolation")
    tenant_id = next(iter(tenant_ids))
    if "critical" in severities:
        workflow = f"{workflow_prefix}-critical"
    elif "warning" in severities:
        workflow = f"{workflow_prefix}-warning"
    else:
        workflow = f"{workflow_prefix}-info"
    return {
        "name": workflow,
        "to": [{"type": "SubscriberId", "subscriberId": "compliance-oncall"}],
        "payload": {
            "source": "alertmanager",
            "receiver": receiver,
            "status": status,
            "alert_count": len(transformed),
            "severity": sorted(severities),
            "tenant_id": tenant_id,
            "alerts": transformed,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        raw = json.loads(args.input.read_text(encoding="utf-8"))
        if not isinstance(raw, dict):
            raise ValueError("root payload must be an object")
        result = transform(raw)
        encoded = json.dumps(result, indent=2, sort_keys=True) + "\n"
        if args.output:
            args.output.write_text(encoded, encoding="utf-8")
        else:
            print(encoded, end="")
        print("Novu bridge payload validation: PASS", file=sys.stderr)
        return 0
    except (OSError, json.JSONDecodeError, ValueError) as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
