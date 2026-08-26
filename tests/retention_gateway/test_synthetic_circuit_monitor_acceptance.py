from __future__ import annotations

import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).parents[2]
SCRIPT = ROOT / "scripts" / "infra" / "accept_synthetic_circuit_monitor.py"


def test_synthetic_monitor_acceptance_script_propagates_open_circuit_state():
    result = subprocess.run(
        [sys.executable, str(SCRIPT)],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=15,
    )
    assert result.returncode == 0, result.stderr
    assert "synthetic circuit monitor acceptance: passed" in result.stdout
