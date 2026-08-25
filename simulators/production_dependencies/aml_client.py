from __future__ import annotations

import json
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass
from typing import Any


@dataclass(frozen=True)
class ScreeningResult:
    decision: str
    review_required: bool
    provider: str
    attempts: int


class AmlScreeningClient:
    """Fail-closed AML client for a real or simulated provider pair."""

    def __init__(self, endpoints: list[str], timeout_seconds: float = 1.0) -> None:
        if not endpoints or any(not endpoint.startswith("http://") and not endpoint.startswith("https://") for endpoint in endpoints):
            raise ValueError("at least one absolute AML endpoint is required")
        if timeout_seconds <= 0 or timeout_seconds > 30:
            raise ValueError("timeout must be greater than 0 and no more than 30 seconds")
        self.endpoints = endpoints
        self.timeout_seconds = timeout_seconds

    def screen(self, subject: dict[str, Any]) -> ScreeningResult:
        attempts = 0
        for endpoint in self.endpoints:
            attempts += 1
            request = urllib.request.Request(
                endpoint,
                data=json.dumps(subject, separators=(",", ":")).encode(),
                method="POST",
                headers={"Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(request, timeout=self.timeout_seconds) as response:
                    if response.status < 200 or response.status >= 300:
                        continue
                    payload = json.loads(response.read())
                    decision = payload.get("decision")
                    if decision not in {"clear", "hit"}:
                        continue
                    return ScreeningResult(
                        decision=decision,
                        review_required=decision == "hit",
                        provider=str(payload.get("provider", "unknown")),
                        attempts=attempts,
                    )
            except (urllib.error.URLError, TimeoutError, socket.timeout, json.JSONDecodeError, ValueError):
                continue

        # Never convert provider unavailability into a clear decision.
        return ScreeningResult(
            decision="indeterminate",
            review_required=True,
            provider="unavailable",
            attempts=attempts,
        )
