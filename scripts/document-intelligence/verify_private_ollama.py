#!/usr/bin/env python3
"""Verify the private Ollama runtime before it may be activated for KYC/KYB.

This performs the pre-activation checks the platform requires and refuses to
report success on partial evidence:

1. The configured endpoint is loopback or a private address (no public ingress).
2. The endpoint is not reachable on the host's routable address.
3. Each allowlisted model is present with the exact expected digest.
4. The visual-primary model declares the ``vision`` capability.
5. The text-fallback model does *not* declare ``vision``, so it can never be
   mistaken for an image analyser.

Exit code 0 means every check passed. Any failure exits non-zero with the
specific reason, so activation stays blocked.
"""

from __future__ import annotations

import ipaddress
import json
import os
import socket
import sys
import urllib.error
import urllib.request
from urllib.parse import urlparse

# The allowlist is intentionally hard-coded here: a digest read from the runtime
# itself would prove nothing, and an environment-supplied digest could be
# silently changed. Updating a model is a reviewed change to this file.
EXPECTED_MODELS = {
    "qwen3-vl:8b": {
        "digest": "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28",
        "role": "visual_primary",
        "requires_vision": True,
    },
    "deepseek-r1:8b": {
        "digest": "6995872bfe4c521a67b32da386cd21d5c6e819b6e0d62f79f64ec83be99f5763",
        "role": "text_fallback",
        "requires_vision": False,
    },
}

TIMEOUT_SECONDS = 30


class CheckFailure(Exception):
    """A pre-activation check that did not pass. Activation stays blocked."""

    def __init__(self, reason: str) -> None:
        super().__init__(reason)
        self.reason = reason


def _post(endpoint: str, path: str, payload: dict | None = None) -> dict:
    url = f"{endpoint.rstrip('/')}{path}"
    data = json.dumps(payload).encode() if payload is not None else None
    request = urllib.request.Request(url, data=data, headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
            return json.loads(response.read().decode())
    except urllib.error.URLError as error:
        raise CheckFailure(f"Endpoint {url} was unreachable: {error}") from error


def check_private_endpoint(endpoint: str) -> str:
    """Reject any endpoint that is not loopback or private."""
    parsed = urlparse(endpoint)
    host = parsed.hostname
    if not host:
        raise CheckFailure(f"Endpoint {endpoint!r} has no host component")
    if parsed.scheme not in {"http", "https"}:
        raise CheckFailure(f"Endpoint scheme {parsed.scheme!r} is not supported")
    try:
        address = ipaddress.ip_address(socket.gethostbyname(host))
    except (OSError, ValueError) as error:
        raise CheckFailure(f"Endpoint host {host!r} could not be resolved: {error}") from error
    if not (address.is_loopback or address.is_private):
        raise CheckFailure(f"Endpoint host {host!r} resolves to public address {address}; public ingress is prohibited")
    return str(address)


def check_no_public_listener(port: int) -> None:
    """Confirm the runtime is not answering on the host's routable address."""
    try:
        routable = socket.gethostbyname(socket.gethostname())
    except OSError:
        # No routable address resolvable means there is nothing to expose.
        return
    address = ipaddress.ip_address(routable)
    if address.is_loopback:
        return
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.settimeout(3)
        if probe.connect_ex((routable, port)) == 0:
            raise CheckFailure(
                f"Runtime accepted a connection on routable address {routable}:{port}; it must bind to loopback only"
            )


def check_models(endpoint: str) -> list[str]:
    tags = _post(endpoint, "/api/tags")
    present = {model["name"]: model for model in tags.get("models", [])}
    verified: list[str] = []
    for name, expected in EXPECTED_MODELS.items():
        model = present.get(name)
        if model is None:
            raise CheckFailure(f"Allowlisted model {name!r} is not installed")
        digest = (model.get("digest") or "").lower()
        if digest != expected["digest"]:
            raise CheckFailure(
                f"Model {name!r} digest {digest!r} does not match the allowlisted digest {expected['digest']!r}"
            )
        shown = _post(endpoint, "/api/show", {"model": name})
        capabilities = set(shown.get("capabilities") or [])
        has_vision = "vision" in capabilities
        if expected["requires_vision"] and not has_vision:
            raise CheckFailure(f"Model {name!r} must declare the vision capability for role {expected['role']}")
        if not expected["requires_vision"] and has_vision:
            raise CheckFailure(
                f"Model {name!r} declares vision but is allowlisted as {expected['role']}; the role mapping is unsafe"
            )
        verified.append(f"{name} digest={digest[:12]} role={expected['role']} vision={has_vision}")
    return verified


def main() -> int:
    endpoint = os.environ.get("OLLAMA_PRIVATE_ENDPOINT", "http://127.0.0.1:11434")
    try:
        resolved = check_private_endpoint(endpoint)
        port = urlparse(endpoint).port or 11434
        check_no_public_listener(port)
        verified = check_models(endpoint)
    except CheckFailure as failure:
        print(f"FAILED: {failure}", file=sys.stderr)
        return 1

    print(f"endpoint={endpoint} resolved={resolved} ingress=private")
    for line in verified:
        print(f"verified {line}")
    print("All private-runtime pre-activation checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
