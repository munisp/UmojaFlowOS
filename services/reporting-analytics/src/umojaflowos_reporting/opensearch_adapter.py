"""Minimal, fail-closed OpenSearch projection writer.

OpenSearch is a *search projection* only. It is never a source of truth for
payment, ledger, compliance, or customer state; PostgreSQL remains canonical.
This writer accepts an already validated redacted projection, performs an
idempotent create over HTTPS (or an explicit local-only development exception),
and verifies an existing document byte-for-byte before acknowledging a retry.
"""

from __future__ import annotations

import base64
import json
import socket
import ssl
from dataclasses import dataclass
from ipaddress import ip_address
from typing import Any, Mapping
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen


class OpenSearchUnavailable(RuntimeError):
    """Raised when a configured search projection cannot be verified."""


def _loopback(host: str | None) -> bool:
    if host in {"localhost", "127.0.0.1", "::1"}:
        return True
    if not host:
        return False
    try:
        return ip_address(host).is_loopback
    except ValueError:
        # Do not resolve a DNS name to decide it is safe for plaintext. A
        # hostname that later resolves remotely must never inherit the local
        # development exception.
        return False


def _safe_index(value: str) -> bool:
    return bool(value.strip()) and all(char not in value for char in "/?#\\") and ".." not in value


@dataclass(frozen=True)
class OpenSearchConfig:
    base_url: str
    bearer_token: str
    timeout_seconds: float = 5.0
    allow_insecure_loopback: bool = False

    def validate(self) -> None:
        parsed = urlparse(self.base_url)
        if not parsed.scheme or not parsed.hostname or parsed.username or parsed.password:
            raise OpenSearchUnavailable("OpenSearch URL must be absolute and contain no embedded credentials")
        if parsed.scheme == "https":
            pass
        elif parsed.scheme == "http" and self.allow_insecure_loopback and _loopback(parsed.hostname):
            pass
        elif parsed.scheme == "http" and not self.allow_insecure_loopback:
            raise OpenSearchUnavailable("OpenSearch plaintext transport requires the explicit loopback exemption")
        elif parsed.scheme == "http":
            raise OpenSearchUnavailable("OpenSearch plaintext transport is permitted on loopback only")
        else:
            raise OpenSearchUnavailable(f"unsupported OpenSearch URL scheme {parsed.scheme!r}")
        if not self.bearer_token.strip():
            raise OpenSearchUnavailable("OpenSearch bearer token is required")
        if self.timeout_seconds <= 0 or self.timeout_seconds > 30:
            raise OpenSearchUnavailable("OpenSearch timeout must be between zero and thirty seconds")


class OpenSearchProjectionWriter:
    def __init__(self, config: OpenSearchConfig) -> None:
        config.validate()
        self._config = config
        self._base_url = config.base_url.rstrip("/")

    def _request(self, method: str, path: str, body: bytes | None = None) -> tuple[int, bytes]:
        request = Request(
            f"{self._base_url}{path}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {self._config.bearer_token}",
                "Content-Type": "application/json",
                "Accept": "application/json",
            },
        )
        try:
            with urlopen(request, timeout=self._config.timeout_seconds, context=ssl.create_default_context()) as response:
                return response.status, response.read()
        except HTTPError as exc:
            return exc.code, exc.read()
        except (URLError, socket.timeout, TimeoutError, ssl.SSLError) as exc:
            raise OpenSearchUnavailable("OpenSearch projection endpoint is unavailable") from exc

    def write(self, index: str, document_id: str, document: Mapping[str, Any]) -> str:
        """Create a redacted projection, or verify an idempotent replay.

        `op_type=create` prevents a retry from overwriting search evidence. A
        409 forces an exact source comparison: a duplicate identifier with
        different material is a conflict, never an update.
        """

        if not _safe_index(index) or not document_id.strip():
            raise OpenSearchUnavailable("OpenSearch index and document id are required and must be path-safe")
        canonical = json.dumps(dict(document), sort_keys=True, separators=(",", ":"))
        encoded_id = quote(document_id, safe="")
        status, body = self._request(
            "PUT",
            f"/{quote(index, safe='')}/_doc/{encoded_id}?op_type=create",
            canonical.encode("utf-8"),
        )
        if status in {200, 201}:
            return "created"
        if status != 409:
            raise OpenSearchUnavailable(f"OpenSearch projection returned status {status}")

        status, existing_body = self._request("GET", f"/{quote(index, safe='')}/_doc/{encoded_id}")
        if status != 200:
            raise OpenSearchUnavailable("OpenSearch reported a duplicate but could not read its existing projection")
        try:
            existing = json.loads(existing_body.decode("utf-8"))["_source"]
        except (UnicodeDecodeError, KeyError, TypeError, json.JSONDecodeError) as exc:
            raise OpenSearchUnavailable("OpenSearch existing projection is not valid JSON") from exc
        if json.dumps(existing, sort_keys=True, separators=(",", ":")) != canonical:
            raise OpenSearchUnavailable("OpenSearch projection conflict: existing evidence differs for this document id")
        return "duplicate"


def redacted_search_document(event: Mapping[str, Any]) -> tuple[str, str, dict[str, Any]]:
    """Build only the two permitted index families: audit evidence and cases."""

    projection_type = event.get("projection_type")
    if projection_type == "audit":
        from .opensearch_projection import build_audit_projection

        projection = build_audit_projection(event)
        return projection.index, projection.document_id, projection.document
    if projection_type == "case":
        required = ("case_id", "status", "corridor", "updated_at")
        if any(not isinstance(event.get(key), str) or not str(event[key]).strip() for key in required):
            raise OpenSearchUnavailable("case id, status, corridor, and update time are required")
        if event["corridor"] not in {"NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"}:
            raise OpenSearchUnavailable("case corridor is not recognised")
        permitted = {"case_id", "status", "corridor", "updated_at", "classification", "reason_codes"}
        unknown = set(event) - permitted - {"projection_type"}
        if unknown:
            raise OpenSearchUnavailable("case projection includes fields that are not approved for search")
        document = {key: event[key] for key in permitted if key in event}
        return "umojaflowos-cases-v1", str(event["case_id"]), document
    raise OpenSearchUnavailable("search projection type must be audit or case")
