#!/usr/bin/env python3
"""Capture redacted observability evidence for an authorized staging run."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

APPROVAL = "CAPTURE_APPROVED_STAGING_EVIDENCE"


def get_json(url: str) -> object:
    request = urllib.request.Request(url, headers={"Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        return json.loads(response.read())


def redact(value: object) -> object:
    if isinstance(value, dict):
        hidden = {"token", "secret", "password", "authorization", "credential", "private_key", "payload", "document", "account", "iban", "email", "phone"}
        return {key: "[REDACTED]" if key.lower() in hidden else redact(item) for key, item in value.items()}
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def capture(url: str, label: str) -> dict[str, object]:
    try:
        return {"label": label, "url": url, "status": "reachable", "body": redact(get_json(url))}
    except Exception as exc:
        return {"label": label, "url": url, "status": "unavailable", "error": type(exc).__name__}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--release-sha", required=True)
    parser.add_argument("--environment", default=os.getenv("OTEL_ENVIRONMENT", "staging"))
    parser.add_argument("--toxiproxy", default=os.getenv("TOXIPROXY_API", "http://127.0.0.1:8474"))
    parser.add_argument("--prometheus", default=os.getenv("PROMETHEUS_URL", "http://127.0.0.1:9090"))
    parser.add_argument("--alertmanager", default=os.getenv("ALERTMANAGER_URL", "http://127.0.0.1:9093"))
    parser.add_argument("--novu-bridge", default=os.getenv("NOVU_BRIDGE_URL", "http://127.0.0.1:8080"))
    parser.add_argument("--execute", action="store_true")
    args = parser.parse_args()
    if args.environment != "staging":
        raise SystemExit("FAIL-CLOSED: evidence capture is restricted to staging")
    if args.execute and os.getenv("STAGING_EVIDENCE_APPROVED") != APPROVAL:
        raise SystemExit(f"FAIL-CLOSED: set STAGING_EVIDENCE_APPROVED={APPROVAL}")
    alerts_query = urlencode({"query": 'ALERTS{environment="staging"}'})
    records = [
        capture(f"{args.toxiproxy.rstrip('/')}/proxies", "toxiproxy-proxies"),
        capture(f"{args.prometheus.rstrip('/')}/-/ready", "prometheus-ready"),
        capture(f"{args.prometheus.rstrip('/')}/api/v1/query?{alerts_query}", "prometheus-alerts"),
        capture(f"{args.alertmanager.rstrip('/')}/-/ready", "alertmanager-ready"),
        capture(f"{args.alertmanager.rstrip('/')}/api/v2/alerts", "alertmanager-alerts"),
        capture(f"{args.novu_bridge.rstrip('/')}/healthz", "novu-bridge-health"),
    ]
    result = {
        "release_sha": args.release_sha,
        "environment": args.environment,
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "mode": "execute" if args.execute else "preflight",
        "network_changes": False,
        "records": records,
    }
    encoded = (json.dumps(result, indent=2, sort_keys=True) + "\n").encode()
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_bytes(encoded)
    print(json.dumps({"path": str(args.out), "sha256": hashlib.sha256(encoded).hexdigest(), "mode": result["mode"]}))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError) as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        raise SystemExit(2)
