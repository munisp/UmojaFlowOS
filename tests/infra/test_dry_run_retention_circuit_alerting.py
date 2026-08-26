from __future__ import annotations

import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).parents[2]
SCRIPT = ROOT / "scripts" / "infra" / "dry_run_retention_circuit_alerting.sh"


def executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def test_dry_run_checks_rules_config_and_both_circuit_receivers(tmp_path):
    log = tmp_path / "commands.log"
    promtool = tmp_path / "promtool"
    amtool = tmp_path / "amtool"
    executable(
        promtool,
        "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'promtool %s\\n' \"$*\" >> \"$DRY_RUN_LOG\"\n",
    )
    executable(
        amtool,
        "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'amtool %s\\n' \"$*\" >> \"$DRY_RUN_LOG\"\n"
        "if [[ \"$1 $2\" == 'config routes' ]]; then\n"
        "  if [[ \"$*\" == *'UmojaRetentionDatabaseCircuitOpenTransition'* ]]; then\n"
        "    printf '%s\\n' pagerduty-retention-postgres-critical webhook-retention-engineering\n"
        "  else\n"
        "    printf '%s\\n' pagerduty-retention-postgres-critical\n"
        "  fi\n"
        "fi\n",
    )
    result = subprocess.run(
        [str(SCRIPT)],
        cwd=ROOT,
        env={
            **os.environ,
            "PROMTOOL_BIN": str(promtool),
            "AMTOOL_BIN": str(amtool),
            "DRY_RUN_LOG": str(log),
        },
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    assert "dry run: passed" in result.stdout
    calls = log.read_text()
    assert "prometheus-production-circuit-alerts.yml" in calls
    assert "prometheus-production-lockwait-alerts.yml" in calls
    assert "check-config" in calls
    assert calls.count("config routes test") == 3
