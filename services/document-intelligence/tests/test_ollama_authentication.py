"""Regressions for the Ollama authentication boundary.

A loopback runtime is protected by host isolation. Any endpoint that crosses a
network boundary must present an authentication control, and these prove the
adapter refuses to run without one.
"""

from __future__ import annotations

import pytest

from umojaflowos_document_intelligence.ollama_adapter import OllamaUnavailable, OllamaVisualAdapter

DIGEST = "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28"


def _base_env(monkeypatch: pytest.MonkeyPatch, base_url: str) -> None:
    monkeypatch.setenv("OLLAMA_BASE_URL", base_url)
    monkeypatch.setenv("OLLAMA_VISION_MODEL", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_ALLOWED_VISION_MODELS", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", DIGEST)
    monkeypatch.setenv("OLLAMA_TLS_CA_FILE", "/etc/ssl/private/internal-ca.pem")
    monkeypatch.delenv("OLLAMA_AUTH_TOKEN", raising=False)
    monkeypatch.delenv("OLLAMA_MTLS_CERT_FILE", raising=False)
    monkeypatch.delenv("OLLAMA_MTLS_KEY_FILE", raising=False)


def test_loopback_endpoint_needs_no_network_credential(monkeypatch: pytest.MonkeyPatch) -> None:
    # Host isolation is the access control for a loopback runtime.
    _base_env(monkeypatch, "http://127.0.0.1:11434")
    monkeypatch.delenv("OLLAMA_TLS_CA_FILE", raising=False)
    OllamaVisualAdapter().validate_activation_configuration()


def test_non_loopback_endpoint_without_authentication_fails_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_env(monkeypatch, "https://ollama.svc.internal:11434")
    with pytest.raises(OllamaUnavailable, match="require an authentication control"):
        OllamaVisualAdapter().validate_activation_configuration()


def test_non_loopback_endpoint_accepts_bearer_credential(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_env(monkeypatch, "https://ollama.svc.internal:11434")
    monkeypatch.setenv("OLLAMA_AUTH_TOKEN", "supplied-by-deployment-secret")
    OllamaVisualAdapter().validate_activation_configuration()


def test_non_loopback_endpoint_accepts_mtls_client_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_env(monkeypatch, "https://ollama.svc.internal:11434")
    monkeypatch.setenv("OLLAMA_MTLS_CERT_FILE", "/etc/ssl/private/client.crt")
    monkeypatch.setenv("OLLAMA_MTLS_KEY_FILE", "/etc/ssl/private/client.key")
    OllamaVisualAdapter().validate_activation_configuration()


def test_blank_bearer_credential_is_not_an_authentication_control(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_env(monkeypatch, "https://ollama.svc.internal:11434")
    # An empty or whitespace token would otherwise silently look configured.
    monkeypatch.setenv("OLLAMA_AUTH_TOKEN", "   ")
    with pytest.raises(OllamaUnavailable, match="require an authentication control"):
        OllamaVisualAdapter().validate_activation_configuration()


def test_half_configured_mtls_is_rejected(monkeypatch: pytest.MonkeyPatch) -> None:
    _base_env(monkeypatch, "https://ollama.svc.internal:11434")
    monkeypatch.setenv("OLLAMA_MTLS_CERT_FILE", "/etc/ssl/private/client.crt")
    with pytest.raises(OllamaUnavailable, match="mTLS requires both"):
        OllamaVisualAdapter().validate_activation_configuration()
