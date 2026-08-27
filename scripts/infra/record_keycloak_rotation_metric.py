#!/usr/bin/env python3
from __future__ import annotations

import argparse
import fcntl
import json
import os
import tempfile
from pathlib import Path

EVENTS = {
    "rotation_failure": "umoja_keycloak_rotation_failures_total",
    "rollback_failure": "umoja_keycloak_rotation_rollback_failures_total",
}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("event", choices=sorted(EVENTS))
    parser.add_argument("--state-file", type=Path, required=True)
    parser.add_argument("--metrics-file", type=Path, required=True)
    args = parser.parse_args()
    args.state_file.parent.mkdir(parents=True, exist_ok=True)
    args.metrics_file.parent.mkdir(parents=True, exist_ok=True)
    lock_path = args.state_file.with_suffix(args.state_file.suffix + ".lock")
    with lock_path.open("a+", encoding="utf-8") as lock:
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        try:
            state = json.loads(args.state_file.read_text(encoding="utf-8")) if args.state_file.exists() else {}
            if not isinstance(state, dict):
                raise RuntimeError("rotation metric state must be an object")
            counts = state.setdefault("counts", {})
            counts[args.event] = int(counts.get(args.event, 0)) + 1
            tmp = tempfile.NamedTemporaryFile("w", dir=args.state_file.parent, delete=False, encoding="utf-8")
            try:
                json.dump(state, tmp, sort_keys=True)
                tmp.write("\n")
                tmp.flush()
                os.fsync(tmp.fileno())
                os.replace(tmp.name, args.state_file)
            finally:
                try: os.unlink(tmp.name)
                except FileNotFoundError: pass
            lines = [
                "# TYPE umoja_keycloak_rotation_failures_total counter",
                f"umoja_keycloak_rotation_failures_total {int(counts.get('rotation_failure', 0))}",
                "# TYPE umoja_keycloak_rotation_rollback_failures_total counter",
                f"umoja_keycloak_rotation_rollback_failures_total {int(counts.get('rollback_failure', 0))}",
            ]
            metric_tmp = tempfile.NamedTemporaryFile("w", dir=args.metrics_file.parent, delete=False, encoding="utf-8")
            try:
                metric_tmp.write("\n".join(lines) + "\n")
                metric_tmp.flush(); os.fsync(metric_tmp.fileno())
                os.replace(metric_tmp.name, args.metrics_file)
            finally:
                try: os.unlink(metric_tmp.name)
                except FileNotFoundError: pass
        finally:
            fcntl.flock(lock.fileno(), fcntl.LOCK_UN)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
