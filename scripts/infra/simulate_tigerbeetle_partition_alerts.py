#!/usr/bin/env python3
"""Simulate TigerBeetle partition/quorum telemetry against Prometheus alert rules.

This harness is local-only. It creates temporary promtool test YAML, runs the
repository alert rules against deterministic mock time series, and deletes the
fixture. It does not contact TigerBeetle, Kubernetes, providers, or production.
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path


def series(name: str, values: str) -> str:
    return f"      - series: '{name}'\n        values: '{values}'\n"


def alert(name: str, labels: dict[str, str], annotations: dict[str, str] | None = None, eval_time: str = "1m") -> str:
    lines = [f"      - eval_time: {eval_time}", f"        alertname: {name}", "        exp_alerts:", "          - exp_labels:"]
    for key, value in labels.items():
        if value.isdigit():
            lines.append(f"              {key}: \"{value}\"")
        else:
            lines.append(f"              {key}: {value}")
    if annotations:
        lines.append("            exp_annotations:")
        for key, value in annotations.items():
            lines.append(f"              {key}: {value}")
    return "\n".join(lines) + "\n"


def build_fixture(rule_file: Path) -> str:
    quorum_labels = {
        "severity": "critical", "urgency": "page", "service": "tigerbeetle",
        "compliance_domain": "ledger_integrity", "action": "fence_settlement",
        "cluster_id": "42", "environment": "production",
    }
    fence_labels = {
        "severity": "critical", "urgency": "page", "service": "tigerbeetle",
        "compliance_domain": "ledger_integrity", "action": "emergency_fence",
        "cluster_id": "42", "environment": "production",
    }
    unknown_labels = {
        "severity": "critical", "urgency": "page", "service": "payment-engine",
        "compliance_domain": "ledger_integrity", "action": "reconcile_before_retry",
        "ledger": "tigerbeetle", "environment": "production",
    }
    mismatch_labels = {
        "severity": "critical", "urgency": "page", "service": "ledger-reconciliation",
        "compliance_domain": "ledger_integrity", "action": "suspend_settlement",
        "ledger": "tigerbeetle", "environment": "production",
    }
    absence_labels = {
        "severity": "critical", "urgency": "page", "service": "tigerbeetle",
        "compliance_domain": "ledger_integrity", "action": "suspend_settlement",
    }
    q_ann = {
        "summary": "TigerBeetle quorum is lost",
        "description": "The ledger exporter reports no trusted TigerBeetle quorum. Fence settlement and do not retry UNKNOWN operations.",
        "runbook_url": "https://docs.example.invalid/runbooks/tigerbeetle-split-brain",
    }
    f_ann = {
        "summary": "Settlement fence is inactive during TigerBeetle instability",
        "description": "The ledger is unhealthy or divergent while the settlement fence is inactive. Invoke the emergency settlement fence and investigate immediately.",
        "runbook_url": "https://docs.example.invalid/runbooks/tigerbeetle-split-brain",
    }
    u_ann = {
        "summary": "TigerBeetle UNKNOWN payment states are increasing",
        "description": "New UNKNOWN payment outcomes were recorded. Hold operations and reconcile by idempotency key before any retry or rail fallback.",
        "runbook_url": "https://docs.example.invalid/runbooks/tigerbeetle-split-brain",
    }
    m_ann = {
        "summary": "PostgreSQL and TigerBeetle reconciliation mismatch",
        "description": "At least one unexplained ledger/projection mismatch was recorded. Suspend settlement and open a financial-integrity incident.",
        "runbook_url": "https://docs.example.invalid/runbooks/tigerbeetle-split-brain",
    }
    a_ann = {
        "summary": "TigerBeetle safety telemetry is absent",
        "description": "Required quorum, node-view, or settlement-fence telemetry is not present. Treat observability loss as unsafe and suspend settlement until restored.",
        "runbook_url": "https://docs.example.invalid/runbooks/tigerbeetle-split-brain",
    }
    return f'''rule_files:\n  - {rule_file}\n\ntests:\n  - name: healthy-cluster-no-critical-alerts\n    interval: 30s\n    input_series:\n{series('umoja_tigerbeetle_cluster_quorum_healthy{cluster_id="42",environment="production"}', '1 1 1 1 1 1')}\n{series('umoja_tigerbeetle_cluster_node_view_divergent{cluster_id="42",environment="production"}', '0 0 0 0 0 0')}\n{series('umoja_tigerbeetle_settlement_fence_active{cluster_id="42",environment="production"}', '1 1 1 1 1 1')}\n    alert_rule_test:\n      - eval_time: 2m\n        alertname: UmojaTigerBeetleQuorumLost\n        exp_alerts: []\n\n  - name: network-partition-fences-settlement\n    interval: 30s\n    input_series:\n{series('umoja_tigerbeetle_cluster_quorum_healthy{cluster_id="42",environment="production"}', '1 0 0 0 0 0')}\n{series('umoja_tigerbeetle_cluster_node_view_divergent{cluster_id="42",environment="production"}', '0 1 1 1 1 1')}\n{series('umoja_tigerbeetle_settlement_fence_active{cluster_id="42",environment="production"}', '1 0 0 0 0 0')}\n    alert_rule_test:\n{alert('UmojaTigerBeetleQuorumLost', quorum_labels, q_ann, '2m')}{alert('UmojaTigerBeetleNodeViewDivergence', quorum_labels, {**q_ann, 'summary': 'TigerBeetle node views are divergent', 'description': 'At least one node reports a cluster membership or consensus view that differs from the trusted view. Do not promote or restart nodes until evidence is captured.'}, '2m')}{alert('UmojaTigerBeetleUnsafeWriteFence', fence_labels, f_ann, '2m')}\n\n  - name: partition-causes-unknown-and-reconciliation-alerts\n    interval: 30s\n    input_series:\n{series('umoja_payment_unknown_state_total{ledger="tigerbeetle",environment="production"}', '0 1 1 2 2 3 3 4 4 5 5 6')}\n{series('umoja_ledger_reconciliation_mismatches_total{ledger="tigerbeetle",environment="production"}', '0 0 1 1 1 2 2 3 3 4 4 5')}\n    alert_rule_test:\n{alert('UmojaTigerBeetleUnknownTransfersGrowing', unknown_labels, u_ann, '3m')}{alert('UmojaTigerBeetleReconciliationMismatch', mismatch_labels, m_ann, '3m')}\n\n  - name: telemetry-loss-is-unsafe\n    interval: 30s\n    input_series:\n{series('umoja_tigerbeetle_cluster_quorum_healthy{cluster_id="42",environment="production"}', '_ _ _ _ _ _ _ _ _ _ _')}\n    alert_rule_test:\n{alert('UmojaTigerBeetleClusterTelemetryAbsent', absence_labels, a_ann, '5m')}\n'''


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a local TigerBeetle partition alert simulation")
    parser.add_argument("--rule-file", type=Path, default=Path("infra/monitoring/umoja-tigerbeetle-cluster-alerts.yml"))
    parser.add_argument("--promtool", type=Path, default=Path(".toolchain/bin/promtool"))
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[2]
    rule_file = (repo / args.rule_file).resolve() if not args.rule_file.is_absolute() else args.rule_file.resolve()
    promtool = (repo / args.promtool).resolve() if not args.promtool.is_absolute() else args.promtool.resolve()
    if not rule_file.is_file():
        print(f"rule file not found: {rule_file}", file=sys.stderr)
        return 2
    if not promtool.is_file():
        found = shutil.which("promtool")
        if found:
            promtool = Path(found)
        else:
            print("promtool not found; run the pinned monitoring bootstrap first", file=sys.stderr)
            return 2
    with tempfile.TemporaryDirectory(prefix="umoja-tigerbeetle-partition-") as directory:
        fixture = Path(directory) / "partition.test.yml"
        fixture.write_text(build_fixture(rule_file), encoding="utf-8")
        result = subprocess.run([str(promtool), "test", "rules", str(fixture)], cwd=repo, text=True)
        if result.returncode:
            print("TigerBeetle partition alert simulation: FAILED", file=sys.stderr)
            return result.returncode
    print("TigerBeetle partition alert simulation: PASS (healthy, partition, UNKNOWN, mismatch, telemetry-loss scenarios)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
