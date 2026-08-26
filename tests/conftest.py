from __future__ import annotations

import os

# Test process only. Production/simulator runtime requires its caller to supply
# SIMULATOR_WEBHOOK_SECRET explicitly through managed configuration.
os.environ.setdefault("SIMULATOR_WEBHOOK_SECRET", "test-only-webhook-secret-material-32-bytes")
