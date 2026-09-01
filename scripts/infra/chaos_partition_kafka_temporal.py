#!/usr/bin/env python3
"""Safe staging chaos test for Kafka and Temporal network partitions.

No production endpoint is accepted. Execution requires --execute and an explicit
CHAOS_APPROVED token. The script uses Toxiproxy only; it never kills processes,
modifies ledger data, or retries payment operations.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from urllib.parse import urlencode, urlparse
from dataclasses import dataclass
from typing import Any

APPROVAL = "EXECUTE_APPROVED_STAGING_CHAOS"
LOCALHOSTS = {"127.0.0.1", "localhost", "::1"}

@dataclass(frozen=True)
class Proxy:
    name: str
    toxic_name: str


def request_json(url: str, method: str = "GET", payload: dict[str, Any] | None = None) -> Any:
    body = None if payload is None else json.dumps(payload).encode()
    request = urllib.request.Request(url, data=body, method=method, headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=5) as response:
        raw = response.read()
        return json.loads(raw) if raw else None


def ensure_local(url: str) -> None:
    host = urlparse(url).hostname
    if host not in LOCALHOSTS:
        raise RuntimeError(f"refusing non-local Toxiproxy endpoint: {host}")


def add_partition(base: str, proxy: Proxy) -> None:
    request_json(f"{base}/proxies/{proxy.name}/toxics", "POST", {"name": proxy.toxic_name, "type": "down", "stream": "downstream", "attributes": {}})


def remove_partition(base: str, proxy: Proxy) -> None:
    try:
        request_json(f"{base}/proxies/{proxy.name}/toxics/{proxy.toxic_name}", "DELETE")
    except urllib.error.HTTPError as exc:
        if exc.code != 404:
            raise


def prom_query(prometheus: str, expression: str) -> Any:
    query = urlencode({"query": expression})
    return request_json(f"{prometheus.rstrip('/')}/api/v1/query?{query}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--execute", action="store_true", help="apply the partition; without this flag only preflight is run")
    parser.add_argument("--duration", type=int, default=45)
    parser.add_argument("--toxiproxy", default=os.getenv("TOXIPROXY_API", "http://127.0.0.1:8474"))
    parser.add_argument("--prometheus", default=os.getenv("PROMETHEUS_URL", "http://127.0.0.1:9090"))
    args = parser.parse_args()
    if args.duration < 30 or args.duration > 300:
        raise SystemExit("duration must be between 30 and 300 seconds")
    ensure_local(args.toxiproxy)
    if args.execute and os.getenv("CHAOS_APPROVED") != APPROVAL:
        raise SystemExit(f"set CHAOS_APPROVED={APPROVAL} to execute staging chaos")
    proxies = [
        Proxy(os.getenv("KAFKA_PROXY_NAME", "kafka"), "umoja-kafka-partition"),
        Proxy(os.getenv("TEMPORAL_PROXY_NAME", "temporal"), "umoja-temporal-partition"),
    ]
    print(json.dumps({"mode": "execute" if args.execute else "preflight", "proxies": [p.name for p in proxies], "duration_seconds": args.duration, "network_changes": False}))
    if not args.execute:
        return 0
    for proxy in proxies:
        request_json(f"{args.toxiproxy}/proxies/{proxy.name}")
    applied: list[Proxy] = []
    try:
        for proxy in proxies:
            add_partition(args.toxiproxy, proxy)
            applied.append(proxy)
        time.sleep(args.duration)
        for expression in (
            'ALERTS{alertname=~".*Telemetry.*|.*Kafka.*|.*Temporal.*"}',
            'up{job="otel-collector"}',
        ):
            try:
                print(json.dumps({"query": expression, "result": prom_query(args.prometheus, expression)}))
            except Exception as exc:  # evidence records the unavailable observer; it never becomes a false pass
                print(json.dumps({"query": expression, "observer_error": str(exc)}))
        return 0
    finally:
        for proxy in reversed(applied):
            remove_partition(args.toxiproxy, proxy)
        print(json.dumps({"cleanup": "completed", "removed": [p.name for p in reversed(applied)]}))


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (urllib.error.URLError, urllib.error.HTTPError, RuntimeError) as exc:
        print(f"FAIL-CLOSED: {exc}", file=sys.stderr)
        raise SystemExit(2)
