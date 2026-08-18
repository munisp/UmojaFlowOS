import importlib.metadata
import os

import pytest


def test_real_document_intelligence_engines_are_installed() -> None:
    assert importlib.metadata.version("paddleocr")
    assert importlib.metadata.version("docling")


def test_ollama_adapter_defaults_to_the_recommended_qwen_vision_profile() -> None:
    from umojaflowos_document_intelligence.ollama_adapter import OllamaVisualAdapter

    assert OllamaVisualAdapter().model == "qwen3-vl:8b"


def test_ollama_activation_rejects_public_or_unpinned_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    from umojaflowos_document_intelligence.ollama_adapter import OllamaUnavailable, OllamaVisualAdapter

    monkeypatch.setenv("OLLAMA_BASE_URL", "https://ollama.example.com")
    monkeypatch.setenv("OLLAMA_VISION_MODEL", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", "sha256:verified")
    with pytest.raises(OllamaUnavailable, match="private or internal"):
        OllamaVisualAdapter().validate_activation_configuration()

    monkeypatch.setenv("OLLAMA_BASE_URL", "https://ollama.internal")
    monkeypatch.delenv("OLLAMA_ALLOWED_MODEL_DIGESTS")
    with pytest.raises(OllamaUnavailable, match="ALLOW"):
        OllamaVisualAdapter().validate_activation_configuration()

    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", "sha256:verified")
    monkeypatch.setenv("OLLAMA_VISION_MODEL", "qwen3-vl:latest")
    with pytest.raises(OllamaUnavailable, match="exact allowlisted"):
        OllamaVisualAdapter().validate_activation_configuration()

    monkeypatch.setenv("OLLAMA_VISION_MODEL", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_MTLS_CERT_FILE", "/tmp/client.crt")
    monkeypatch.delenv("OLLAMA_MTLS_KEY_FILE", raising=False)
    with pytest.raises(OllamaUnavailable, match="mTLS requires"):
        OllamaVisualAdapter().validate_activation_configuration()
