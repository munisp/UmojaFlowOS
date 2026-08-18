"""Regressions for the private-Ollama pre-activation verifier.

These exercise the verifier's decision logic directly with controlled inputs, so
they prove the checks reject drift rather than merely passing against the
currently installed runtime.
"""

from __future__ import annotations

import importlib.util
from pathlib import Path

import pytest

_MODULE_PATH = (
    Path(__file__).resolve().parents[3] / "scripts" / "document-intelligence" / "verify_private_ollama.py"
)
_spec = importlib.util.spec_from_file_location("verify_private_ollama", _MODULE_PATH)
assert _spec and _spec.loader
verifier = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(verifier)


QWEN_DIGEST = verifier.EXPECTED_MODELS["qwen3-vl:8b"]["digest"]
DEEPSEEK_DIGEST = verifier.EXPECTED_MODELS["deepseek-r1:8b"]["digest"]


def _responder(tags: dict, shown: dict):
    """Build a stand-in transport that returns the given runtime responses."""

    def _post(endpoint: str, path: str, payload: dict | None = None) -> dict:
        if path == "/api/tags":
            return tags
        assert payload is not None
        return shown[payload["model"]]

    return _post


def test_rejects_public_endpoint() -> None:
    with pytest.raises(verifier.CheckFailure, match="public ingress is prohibited"):
        verifier.check_private_endpoint("http://93.184.216.34:11434")


def test_accepts_loopback_endpoint() -> None:
    assert verifier.check_private_endpoint("http://127.0.0.1:11434") == "127.0.0.1"


def test_rejects_unsupported_scheme() -> None:
    with pytest.raises(verifier.CheckFailure, match="scheme"):
        verifier.check_private_endpoint("ftp://127.0.0.1:11434")


def test_rejects_digest_drift(monkeypatch: pytest.MonkeyPatch) -> None:
    drifted = "f" * 64
    tags = {"models": [{"name": "qwen3-vl:8b", "digest": drifted}, {"name": "deepseek-r1:8b", "digest": DEEPSEEK_DIGEST}]}
    shown = {
        "qwen3-vl:8b": {"capabilities": ["completion", "vision"]},
        "deepseek-r1:8b": {"capabilities": ["completion"]},
    }
    monkeypatch.setattr(verifier, "_post", _responder(tags, shown))
    with pytest.raises(verifier.CheckFailure, match="does not match the allowlisted digest"):
        verifier.check_models("http://127.0.0.1:11434")


def test_rejects_missing_model(monkeypatch: pytest.MonkeyPatch) -> None:
    tags = {"models": [{"name": "deepseek-r1:8b", "digest": DEEPSEEK_DIGEST}]}
    shown = {"deepseek-r1:8b": {"capabilities": ["completion"]}}
    monkeypatch.setattr(verifier, "_post", _responder(tags, shown))
    with pytest.raises(verifier.CheckFailure, match="is not installed"):
        verifier.check_models("http://127.0.0.1:11434")


def test_rejects_visual_primary_without_vision(monkeypatch: pytest.MonkeyPatch) -> None:
    tags = {
        "models": [
            {"name": "qwen3-vl:8b", "digest": QWEN_DIGEST},
            {"name": "deepseek-r1:8b", "digest": DEEPSEEK_DIGEST},
        ]
    }
    shown = {
        # A runtime that no longer declares vision cannot serve the visual role.
        "qwen3-vl:8b": {"capabilities": ["completion", "tools"]},
        "deepseek-r1:8b": {"capabilities": ["completion"]},
    }
    monkeypatch.setattr(verifier, "_post", _responder(tags, shown))
    with pytest.raises(verifier.CheckFailure, match="must declare the vision capability"):
        verifier.check_models("http://127.0.0.1:11434")


def test_rejects_text_fallback_that_claims_vision(monkeypatch: pytest.MonkeyPatch) -> None:
    tags = {
        "models": [
            {"name": "qwen3-vl:8b", "digest": QWEN_DIGEST},
            {"name": "deepseek-r1:8b", "digest": DEEPSEEK_DIGEST},
        ]
    }
    shown = {
        "qwen3-vl:8b": {"capabilities": ["completion", "vision"]},
        # If the text fallback ever gained vision, the role mapping would be unsafe.
        "deepseek-r1:8b": {"capabilities": ["completion", "vision"]},
    }
    monkeypatch.setattr(verifier, "_post", _responder(tags, shown))
    with pytest.raises(verifier.CheckFailure, match="the role mapping is unsafe"):
        verifier.check_models("http://127.0.0.1:11434")


def test_accepts_verified_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    tags = {
        "models": [
            {"name": "qwen3-vl:8b", "digest": QWEN_DIGEST},
            {"name": "deepseek-r1:8b", "digest": DEEPSEEK_DIGEST},
        ]
    }
    shown = {
        "qwen3-vl:8b": {"capabilities": ["completion", "vision", "tools", "thinking"]},
        "deepseek-r1:8b": {"capabilities": ["completion", "tools", "thinking"]},
    }
    monkeypatch.setattr(verifier, "_post", _responder(tags, shown))
    verified = verifier.check_models("http://127.0.0.1:11434")
    assert any("role=visual_primary" in line and "vision=True" in line for line in verified)
    assert any("role=text_fallback" in line and "vision=False" in line for line in verified)
