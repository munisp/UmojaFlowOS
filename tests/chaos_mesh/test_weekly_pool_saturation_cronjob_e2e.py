"""Opt-in in-cluster test for the weekly Chaos pool-saturation CronJob.

Requires an isolated staging cluster with Chaos Mesh and the validator image/secrets.
Run only with RUN_CHAOS_MESH_CRONJOB_E2E=1.
"""
from __future__ import annotations

import os
import subprocess
import time
from pathlib import Path

import pytest

pytestmark = pytest.mark.chaos

if os.getenv("RUN_CHAOS_MESH_CRONJOB_E2E") != "1":
    pytest.skip("set RUN_CHAOS_MESH_CRONJOB_E2E=1 to run in-cluster CronJob test", allow_module_level=True)

ROOT = Path(__file__).parents[2]
NAMESPACE = os.getenv("CHAOS_NAMESPACE", "security")
NETWORK_CHAOS = ROOT / "infra" / "retention-gateway" / "chaos-mesh" / "networkchaos-worker-postgres-pool-saturation.yaml"
CRONJOB = "umoja-retention-postgres-pool-weekly-validate"


def kubectl(*args, check=True):
    return subprocess.run(["kubectl", *args], text=True, capture_output=True, check=check)


def test_weekly_cronjob_parses_live_prometheus_metrics_during_active_fault():
    job = f"retention-pool-e2e-{int(time.time())}"
    kubectl("-n", NAMESPACE, "apply", "-f", str(NETWORK_CHAOS))
    try:
        time.sleep(int(os.getenv("CHAOS_SETTLE_SECONDS", "20")))
        kubectl("-n", NAMESPACE, "create", "job", f"--from=cronjob/{CRONJOB}", job)
        kubectl("-n", NAMESPACE, "wait", f"--for=condition=complete", f"job/{job}", "--timeout=15m")
        logs = kubectl("-n", NAMESPACE, "logs", f"job/{job}").stdout
        assert '"passed": true' in logs
        assert "database_connection_pool_saturated" not in logs or '"passed": true' in logs
    finally:
        kubectl("-n", NAMESPACE, "delete", f"job/{job}", "--ignore-not-found", check=False)
        kubectl("-n", NAMESPACE, "delete", "-f", str(NETWORK_CHAOS), "--ignore-not-found", check=False)
