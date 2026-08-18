"""Resolves selector-derived model provenance from the live runtime inventory.

The control plane must not be able to assert which model analysed a document.
This module queries the configured private Ollama runtime for its installed
model digests, applies the fail-closed selection policy, and returns the exact
tag, digest, and role that an analysis job may record. If the runtime is
unreachable, the required model is absent, or the digest is not allowlisted, the
resolver raises and no analysis job may be created.
"""

from __future__ import annotations

import os
from dataclasses import asdict
from urllib.parse import urlparse

import httpx

from .model_selection import (
    AnalysisModality,
    ModelSelectionUnavailable,
    SelectedModel,
    select_review_only_model,
)


class ProvenanceUnavailable(RuntimeError):
    """Raised when selector-derived provenance cannot be established."""


def _allowlisted_digests() -> set[str]:
    raw = os.environ.get("OLLAMA_ALLOWED_MODEL_DIGESTS", "")
    return {digest.strip() for digest in raw.split(",") if digest.strip()}


def _require_private_endpoint(base_url: str) -> str:
    if not base_url:
        raise ProvenanceUnavailable("OLLAMA_BASE_URL is not configured")
    parsed = urlparse(base_url)
    hostname = (parsed.hostname or "").lower()
    private_host = (
        hostname in {"localhost", "127.0.0.1", "::1"}
        or hostname.endswith(".internal")
        or hostname.endswith(".local")
    )
    if not private_host:
        raise ProvenanceUnavailable("model provenance may only be resolved from a private endpoint")
    return base_url.rstrip("/")


def installed_digests(tags_payload: object) -> dict[str, str]:
    """Extracts a tag-to-digest map from an Ollama ``/api/tags`` payload.

    Malformed entries are ignored rather than guessed at, so an incomplete
    inventory simply fails to satisfy the selector.
    """
    if not isinstance(tags_payload, dict):
        return {}
    models = tags_payload.get("models")
    if not isinstance(models, list):
        return {}
    inventory: dict[str, str] = {}
    for entry in models:
        if not isinstance(entry, dict):
            continue
        tag = entry.get("name") or entry.get("model")
        digest = entry.get("digest")
        if isinstance(tag, str) and isinstance(digest, str):
            inventory[tag] = digest.removeprefix("sha256:")
    return inventory


def resolve_from_inventory(modality: AnalysisModality, inventory: dict[str, str]) -> SelectedModel:
    """Applies the selection policy and the digest allowlist to an inventory."""
    try:
        selected = select_review_only_model(modality, inventory)
    except ModelSelectionUnavailable as exc:
        raise ProvenanceUnavailable(str(exc)) from exc

    allowlist = _allowlisted_digests()
    if not allowlist:
        raise ProvenanceUnavailable("OLLAMA_ALLOWED_MODEL_DIGESTS must contain the verified model digest")
    if selected.digest not in allowlist:
        raise ProvenanceUnavailable(
            f"resolved digest for {selected.tag} is not allowlisted; refusing to record provenance"
        )
    return selected


async def resolve_model_provenance(modality: AnalysisModality) -> dict[str, str]:
    """Queries the live runtime and returns provenance fields for persistence."""
    base_url = _require_private_endpoint(os.environ.get("OLLAMA_BASE_URL", ""))
    timeout = float(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "45"))
    ca_file = os.environ.get("OLLAMA_TLS_CA_FILE")
    cert_file = os.environ.get("OLLAMA_MTLS_CERT_FILE")
    key_file = os.environ.get("OLLAMA_MTLS_KEY_FILE")

    client_options: dict[str, object] = {"timeout": timeout}
    if ca_file:
        client_options["verify"] = ca_file
    if cert_file and key_file:
        client_options["cert"] = (cert_file, key_file)

    try:
        async with httpx.AsyncClient(**client_options) as client:
            response = await client.get(f"{base_url}/api/tags")
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ProvenanceUnavailable(f"model inventory could not be read: {exc}") from exc

    selected = resolve_from_inventory(modality, installed_digests(payload))
    fields = asdict(selected)
    return {
        "selectedModelTag": fields["tag"],
        "selectedModelDigest": fields["digest"],
        "selectedModelRole": fields["role"],
    }
