"""Authorised regulatory-channel submission boundary.

The client is deliberately generic because regulator submission credentials and
message profiles are issued to the regulated entity outside source control. It
submits only an already-validated report artefact plus its immutable digest,
requires a managed secret file, and returns an acknowledgement receipt. It
never infers an external reference or marks a report submitted when the channel
is unavailable.
"""

from __future__ import annotations

import hashlib
import json
import os
import ssl
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


class RegulatorySubmissionUnavailable(RuntimeError):
    """Raised when an authorised channel is disabled or cannot prove a receipt."""


@dataclass(frozen=True)
class RegulatorySubmissionRequest:
    regulator: str
    report_type: str
    regulated_entity_id: str
    artifact_uri: str
    artifact_digest: str
    evidence_manifest: dict[str, Any]
    correlation_id: str


@dataclass(frozen=True)
class RegulatorySubmissionReceipt:
    channel_reference: str
    external_reference: str
    state: str
    response_evidence_sha256: str


def _resolve_secret(reference: str, root: str) -> str:
    if not reference.startswith("file:///"):
        raise RegulatorySubmissionUnavailable("regulatory channel API-key reference must be a file:/// path")
    approved_root = Path(root).resolve(strict=True)
    candidate = Path(reference.removeprefix("file://")).resolve(strict=True)
    if candidate == approved_root or approved_root not in candidate.parents:
        raise RegulatorySubmissionUnavailable("regulatory channel API-key reference escapes the approved secret root")
    value = candidate.read_text(encoding="utf-8")
    if len(value.encode("utf-8")) < 12:
        raise RegulatorySubmissionUnavailable("regulatory channel API-key material is unavailable")
    return value


class AuthorisedRegulatoryChannel:
    def __init__(self, *, endpoint: str, api_key: str, channel_reference: str, timeout_seconds: float = 15.0) -> None:
        parsed = urlparse(endpoint)
        if parsed.scheme != "https" or not parsed.netloc or parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise RegulatorySubmissionUnavailable("regulatory channel endpoint must be a credential-free HTTPS URL")
        if not channel_reference.strip() or len(channel_reference) > 255:
            raise RegulatorySubmissionUnavailable("regulatory channel reference is required")
        self._endpoint = endpoint
        self._api_key = api_key
        self._channel_reference = channel_reference
        self._timeout_seconds = timeout_seconds

    @classmethod
    def from_environment(cls) -> "AuthorisedRegulatoryChannel | None":
        enabled = os.environ.get("UMOJA_REGULATORY_SUBMISSION_ENABLED", "false").lower()
        if enabled not in {"true", "false"}:
            raise RegulatorySubmissionUnavailable("UMOJA_REGULATORY_SUBMISSION_ENABLED must be true or false")
        if enabled == "false":
            return None
        api_key = _resolve_secret(
            os.environ.get("UMOJA_REGULATORY_SUBMISSION_API_KEY_SECRET_REFERENCE", ""),
            os.environ.get("UMOJA_REGULATORY_SUBMISSION_MATERIAL_ROOT", "/run/umoja-secrets"),
        )
        return cls(
            endpoint=os.environ.get("UMOJA_REGULATORY_SUBMISSION_ENDPOINT", ""),
            api_key=api_key,
            channel_reference=os.environ.get("UMOJA_REGULATORY_SUBMISSION_CHANNEL_REFERENCE", ""),
        )

    def submit(self, request: RegulatorySubmissionRequest) -> RegulatorySubmissionReceipt:
        if request.regulator not in {"CBN", "CBK", "SARB"}:
            raise RegulatorySubmissionUnavailable("unsupported regulatory channel")
        if len(request.artifact_digest) != 64 or any(char not in "0123456789abcdef" for char in request.artifact_digest):
            raise RegulatorySubmissionUnavailable("report artefact digest must be SHA-256")
        if not request.artifact_uri.startswith("https://") or not request.correlation_id.strip():
            raise RegulatorySubmissionUnavailable("report artefact URI and correlation ID are required")
        payload = json.dumps(
            {
                "regulator": request.regulator,
                "report_type": request.report_type,
                "regulated_entity_id": request.regulated_entity_id,
                "artifact_uri": request.artifact_uri,
                "artifact_digest": request.artifact_digest,
                "evidence_manifest": request.evidence_manifest,
                "correlation_id": request.correlation_id,
            },
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        outbound = Request(
            self._endpoint,
            data=payload,
            method="POST",
            headers={
                "Accept": "application/json",
                "Content-Type": "application/json",
                "Authorization": f"Bearer {self._api_key}",
                "X-Umoja-Correlation-Id": request.correlation_id,
            },
        )
        try:
            with urlopen(outbound, timeout=self._timeout_seconds, context=ssl.create_default_context()) as response:
                body = response.read(256 * 1024)
                if response.status not in {200, 201, 202}:
                    raise RegulatorySubmissionUnavailable(f"regulatory channel returned HTTP {response.status}")
        except HTTPError as error:
            raise RegulatorySubmissionUnavailable(f"regulatory channel returned HTTP {error.code}") from error
        except URLError as error:
            raise RegulatorySubmissionUnavailable("regulatory channel is unavailable") from error
        try:
            receipt = json.loads(body)
        except json.JSONDecodeError as error:
            raise RegulatorySubmissionUnavailable("regulatory channel response was not JSON") from error
        external_reference = receipt.get("external_reference")
        state = receipt.get("state")
        if not isinstance(external_reference, str) or not external_reference.strip() or not isinstance(state, str) or state not in {"submitted", "accepted", "rejected"}:
            raise RegulatorySubmissionUnavailable("regulatory channel did not return an attributable receipt")
        return RegulatorySubmissionReceipt(
            channel_reference=self._channel_reference,
            external_reference=external_reference,
            state=state,
            response_evidence_sha256=hashlib.sha256(body).hexdigest(),
        )
