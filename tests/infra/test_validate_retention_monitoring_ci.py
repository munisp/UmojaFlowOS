from __future__ import annotations

import os
import subprocess
from pathlib import Path


ROOT = Path(__file__).parents[2]
SCRIPT = ROOT / "scripts" / "infra" / "validate_retention_monitoring_ci.sh"


def executable(path: Path, content: str) -> None:
    path.write_text(content)
    path.chmod(0o755)


def test_ci_validator_checks_rules_routes_and_service_monitor(tmp_path):
    log = tmp_path / "commands.log"
    promtool = tmp_path / "promtool"
    amtool = tmp_path / "amtool"
    executable(
        promtool,
        "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'promtool %s\\n' \"$*\" >> \"$CI_VALIDATE_LOG\"\n",
    )
    executable(
        amtool,
        "#!/usr/bin/env bash\nset -euo pipefail\nprintf 'amtool %s\\n' \"$*\" >> \"$CI_VALIDATE_LOG\"\n"
        "if [[ \"$1 $2\" == 'config routes' ]]; then\n"
        "  printf '%s\\n' pagerduty-retention-postgres-critical webhook-retention-engineering\n"
        "fi\n",
    )
    result = subprocess.run(
        [str(SCRIPT)],
        cwd=ROOT,
        env={
            **os.environ,
            "PROMTOOL_BIN": str(promtool),
            "AMTOOL_BIN": str(amtool),
            "CI_VALIDATE_LOG": str(log),
        },
        text=True,
        capture_output=True,
    )
    assert result.returncode == 0, result.stderr
    assert "retention monitoring CI validation: passed" in result.stdout
    calls = log.read_text()
    assert calls.count("promtool check rules") >= 3
    assert "amtool check-config" in calls
    assert calls.count("amtool config routes test") == 2
