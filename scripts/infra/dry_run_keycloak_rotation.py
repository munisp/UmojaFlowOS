#!/usr/bin/env python3
"""Offline state-machine test for Keycloak/Vault evidence-secret rotation."""
from __future__ import annotations

import argparse
import hashlib
import json
from dataclasses import dataclass, field
from pathlib import Path


@dataclass
class FakeRotation:
    scenario: str
    events: list[str] = field(default_factory=list)
    vault_versions: list[dict[str, str]] = field(default_factory=list)
    keycloak_generation: int = 0

    def secret(self, label: str) -> str:
        self.keycloak_generation += 1
        return hashlib.sha256(f"dry-run:{label}:{self.keycloak_generation}".encode()).hexdigest()

    def rotate_keycloak(self, label: str) -> str:
        value = self.secret(label)
        self.events.append(f"keycloak_secret_generated:{label}")
        return value

    def write_vault(self, secret: str, operation: str) -> None:
        self.vault_versions.append(
            {
                "version": str(len(self.vault_versions) + 1),
                "operation": operation,
                "secret_digest": hashlib.sha256(secret.encode()).hexdigest(),
            }
        )
        self.events.append(f"vault_version_written:{operation}")

    def canary(self, secret: str, recovery: bool = False) -> bool:
        mode = "recovery" if recovery else "primary"
        failed = (self.scenario in {"canary-fails", "rollback-fails"} and not recovery) or (
            self.scenario == "rollback-fails" and recovery
        )
        self.events.append(f"canary_{mode}_{'failed' if failed else 'passed'}")
        return not failed

    def run(self) -> dict[str, object]:
        primary = self.rotate_keycloak("primary")
        self.write_vault(primary, "primary_rotation")
        if self.canary(primary):
            self.events.append("rotation_succeeded")
            return self.result("passed", None)

        self.events.append("primary_failed_begin_compensating_rollback")
        recovery = self.rotate_keycloak("rollback")
        self.write_vault(recovery, "compensating_rollback")
        if self.canary(recovery, recovery=True):
            self.events.append("rotation_rolled_back")
            return self.result("rolled_back", "primary_canary_failed")

        self.events.append("rollback_failed_escalate")
        return self.result("rollback_failed", "primary_and_recovery_canaries_failed")

    def result(self, status: str, failure: str | None) -> dict[str, object]:
        return {
            "mode": "offline-dry-run",
            "scenario": self.scenario,
            "status": status,
            "failure_reason": failure,
            "network_calls": 0,
            "secret_values_emitted": False,
            "events": self.events,
            "vault_versions": self.vault_versions,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=("success", "canary-fails", "rollback-fails"), default="success")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    report = FakeRotation(args.scenario).run()
    if args.output:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2))
    return 0 if report["status"] in {"passed", "rolled_back"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
