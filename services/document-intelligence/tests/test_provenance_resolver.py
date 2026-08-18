from __future__ import annotations

import pytest

from umojaflowos_document_intelligence.provenance_resolver import (
    ProvenanceUnavailable,
    installed_digests,
    resolve_from_inventory,
)

QWEN_DIGEST = "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28"
DEEPSEEK_DIGEST = "6995872bfe4c521a67b32da386cd21d5c6e819b6e0d62f79f64ec83be99f5763"


def test_installed_digests_reads_tag_and_model_keys() -> None:
    payload = {
        "models": [
            {"name": "qwen3-vl:8b", "digest": f"sha256:{QWEN_DIGEST}"},
            {"model": "deepseek-r1:8b", "digest": DEEPSEEK_DIGEST},
        ]
    }
    assert installed_digests(payload) == {
        "qwen3-vl:8b": QWEN_DIGEST,
        "deepseek-r1:8b": DEEPSEEK_DIGEST,
    }


def test_installed_digests_ignores_malformed_entries() -> None:
    payload = {"models": [{"name": "qwen3-vl:8b"}, "not-a-dict", {"digest": DEEPSEEK_DIGEST}]}
    assert installed_digests(payload) == {}


def test_installed_digests_rejects_non_inventory_payloads() -> None:
    assert installed_digests(None) == {}
    assert installed_digests({"models": "qwen3-vl:8b"}) == {}


def test_image_modality_resolves_the_visual_primary(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", QWEN_DIGEST)
    selected = resolve_from_inventory("image", {"qwen3-vl:8b": QWEN_DIGEST})
    assert selected.tag == "qwen3-vl:8b"
    assert selected.digest == QWEN_DIGEST
    assert selected.role == "visual_primary"


def test_text_modality_resolves_the_text_fallback(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", DEEPSEEK_DIGEST)
    selected = resolve_from_inventory("text", {"deepseek-r1:8b": DEEPSEEK_DIGEST})
    assert selected.tag == "deepseek-r1:8b"
    assert selected.role == "text_fallback"


def test_missing_required_model_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", QWEN_DIGEST)
    with pytest.raises(ProvenanceUnavailable):
        resolve_from_inventory("image", {"deepseek-r1:8b": DEEPSEEK_DIGEST})


def test_absent_allowlist_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("OLLAMA_ALLOWED_MODEL_DIGESTS", raising=False)
    with pytest.raises(ProvenanceUnavailable):
        resolve_from_inventory("image", {"qwen3-vl:8b": QWEN_DIGEST})


def test_digest_drift_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    """A model reinstalled with a different digest must not silently be trusted."""
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", QWEN_DIGEST)
    drifted = "0" * 64
    with pytest.raises(ProvenanceUnavailable):
        resolve_from_inventory("image", {"qwen3-vl:8b": drifted})


def test_wrong_model_for_modality_is_never_substituted(monkeypatch: pytest.MonkeyPatch) -> None:
    """DeepSeek is text-only: it must never be accepted as the visual primary."""
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", f"{QWEN_DIGEST},{DEEPSEEK_DIGEST}")
    with pytest.raises(ProvenanceUnavailable):
        resolve_from_inventory("image", {"deepseek-r1:8b": DEEPSEEK_DIGEST})


def test_unsupported_modality_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", QWEN_DIGEST)
    with pytest.raises(ProvenanceUnavailable):
        resolve_from_inventory("audio", {"qwen3-vl:8b": QWEN_DIGEST})  # type: ignore[arg-type]
