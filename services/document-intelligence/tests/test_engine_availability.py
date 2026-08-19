import importlib.metadata
import os
import asyncio

import pytest


def test_real_document_intelligence_engines_are_installed() -> None:
    assert importlib.metadata.version("paddleocr")
    assert importlib.metadata.version("docling")


def test_ollama_adapter_defaults_to_the_recommended_qwen_vision_profile() -> None:
    from umojaflowos_document_intelligence.ollama_adapter import OllamaVisualAdapter

    assert OllamaVisualAdapter().model == "qwen3-vl:8b"


def test_local_qwen3_vl_digest_allowlist_is_explicit_and_drifted_value_is_distinct(monkeypatch: pytest.MonkeyPatch) -> None:
    from umojaflowos_document_intelligence.ollama_adapter import OllamaVisualAdapter

    verified_digest = "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28"
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    monkeypatch.setenv("OLLAMA_VISION_MODEL", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_ALLOWED_VISION_MODELS", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", verified_digest)
    adapter = OllamaVisualAdapter()
    adapter.validate_activation_configuration()
    assert verified_digest in adapter.allowed_digests
    assert "sha256:drifted" not in adapter.allowed_digests


def test_ollama_assessment_rejects_runtime_digest_drift(monkeypatch: pytest.MonkeyPatch) -> None:
    from umojaflowos_document_intelligence import ollama_adapter
    from umojaflowos_document_intelligence.ollama_adapter import OllamaUnavailable, OllamaVisualAdapter

    verified_digest = "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28"
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", verified_digest)

    class Response:
        def __init__(self, body: dict[str, object]) -> None: self.body = body
        def raise_for_status(self) -> None: return None
        def json(self) -> dict[str, object]: return self.body
    class Client:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): return None
        async def post(self, url: str, **_):
            return Response({"details": {"digest": "digest-drifted"}} if url.endswith("/api/show") else {"message": {"content": "{}"}})
        # The adapter reads the tag inventory as a digest fallback when
        # /api/show omits one, so the stub must answer GET as well. Without it
        # the test failed on a missing attribute rather than on the drift it is
        # meant to detect, which would have masked the real assertion.
        async def get(self, url: str, **_):
            return Response({"models": [{"name": "qwen3-vl:8b", "digest": "digest-drifted"}]})
    monkeypatch.setattr(ollama_adapter.httpx, "AsyncClient", lambda **_: Client())
    with pytest.raises(OllamaUnavailable, match="digest is absent or not allowlisted"):
        asyncio.run(OllamaVisualAdapter().assess(b"x", "image/png"))


def test_ollama_assessment_accepts_exact_verified_runtime_digest(monkeypatch: pytest.MonkeyPatch) -> None:
    from umojaflowos_document_intelligence import ollama_adapter
    from umojaflowos_document_intelligence.ollama_adapter import OllamaVisualAdapter

    verified_digest = "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28"
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", verified_digest)
    payload = {"visual_consistency": "insufficient_evidence", "presentation_attack_risk": "insufficient_evidence", "signals": [], "limitations": ["Mocked runtime provenance test only; no document inference occurred."]}

    class Response:
        def __init__(self, body: dict[str, object]) -> None: self.body = body
        def raise_for_status(self) -> None: return None
        def json(self) -> dict[str, object]: return self.body
    class Client:
        async def __aenter__(self): return self
        async def __aexit__(self, *_): return None
        async def post(self, url: str, **_):
            return Response({"details": {"digest": verified_digest}} if url.endswith("/api/show") else {"message": {"content": __import__("json").dumps(payload)}})
        async def get(self, url: str, **_):
            return Response({"models": [{"name": "qwen3-vl:8b", "digest": verified_digest}]})
    monkeypatch.setattr(ollama_adapter.httpx, "AsyncClient", lambda **_: Client())
    assessment, digest = asyncio.run(OllamaVisualAdapter().assess(b"x", "image/png"))
    assert digest == verified_digest
    assert assessment.visual_consistency == "insufficient_evidence"


def test_ollama_activation_rejects_public_or_unpinned_configuration(monkeypatch: pytest.MonkeyPatch) -> None:
    from umojaflowos_document_intelligence.ollama_adapter import OllamaUnavailable, OllamaVisualAdapter

    monkeypatch.setenv("OLLAMA_BASE_URL", "https://ollama.example.com")
    monkeypatch.setenv("OLLAMA_VISION_MODEL", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", "sha256:verified")
    with pytest.raises(OllamaUnavailable, match="private or internal"):
        OllamaVisualAdapter().validate_activation_configuration()

    monkeypatch.setenv("OLLAMA_BASE_URL", "https://ollama.internal")
    monkeypatch.delenv("OLLAMA_TLS_CA_FILE", raising=False)
    with pytest.raises(OllamaUnavailable, match="TLS_CA"):
        OllamaVisualAdapter().validate_activation_configuration()

    monkeypatch.setenv("OLLAMA_TLS_CA_FILE", "/tmp/ca.pem")
    monkeypatch.delenv("OLLAMA_ALLOWED_MODEL_DIGESTS")
    with pytest.raises(OllamaUnavailable, match="ALLOW"):
        OllamaVisualAdapter().validate_activation_configuration()

    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", "sha256:verified")
    monkeypatch.setenv("OLLAMA_VISION_MODEL", "qwen3-vl:latest")
    with pytest.raises(OllamaUnavailable, match="exact allowlisted"):
        OllamaVisualAdapter().validate_activation_configuration()

    monkeypatch.setenv("OLLAMA_VISION_MODEL", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_ALLOWED_VISION_MODELS", "qwen3-vl:7b")
    with pytest.raises(OllamaUnavailable, match="exact allowlisted"):
        OllamaVisualAdapter().validate_activation_configuration()

    monkeypatch.setenv("OLLAMA_ALLOWED_VISION_MODELS", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_MTLS_CERT_FILE", "/tmp/client.crt")
    monkeypatch.delenv("OLLAMA_MTLS_KEY_FILE", raising=False)
    with pytest.raises(OllamaUnavailable, match="mTLS requires"):
        OllamaVisualAdapter().validate_activation_configuration()
