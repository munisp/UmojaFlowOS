import asyncio

import httpx
import pytest

from umojaflowos_document_intelligence import ollama_adapter
from umojaflowos_document_intelligence.ollama_adapter import OllamaUnavailable, OllamaVisualAdapter


_REAL_ASYNC_CLIENT = httpx.AsyncClient


class _MockAsyncClient:
    def __init__(self, handler, **_: object) -> None:
        self._client = _REAL_ASYNC_CLIENT(transport=httpx.MockTransport(handler))

    async def __aenter__(self):
        await self._client.__aenter__()
        return self._client

    async def __aexit__(self, exc_type, exc, tb):
        return await self._client.__aexit__(exc_type, exc, tb)


def _configure(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("OLLAMA_BASE_URL", "http://127.0.0.1:11434")
    monkeypatch.setenv("OLLAMA_VISION_MODEL", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_ALLOWED_VISION_MODELS", "qwen3-vl:8b")
    monkeypatch.setenv("OLLAMA_ALLOWED_MODEL_DIGESTS", "sha256:approved")


def _patch_transport(monkeypatch: pytest.MonkeyPatch, handler) -> None:
    monkeypatch.setattr(ollama_adapter.httpx, "AsyncClient", lambda **kwargs: _MockAsyncClient(handler, **kwargs))


def test_non_2xx_show_response_is_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(503, json={"error": "signer unavailable"}, request=request)
    _patch_transport(monkeypatch, handler)
    with pytest.raises(OllamaUnavailable, match="Ollama request failed"):
        asyncio.run(OllamaVisualAdapter().assess(b"image", "image/png"))


def test_malformed_model_json_is_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/show"):
            return httpx.Response(200, content=b"not-json", request=request)
        if request.url.path.endswith("/api/tags"):
            return httpx.Response(200, json={"models": []}, request=request)
        if request.url.path.endswith("/api/chat"):
            return httpx.Response(200, json={"message": {"content": "{}"}}, request=request)
        raise AssertionError(f"unexpected request: {request.url}")

    _patch_transport(monkeypatch, handler)
    with pytest.raises(OllamaUnavailable, match="Ollama response JSON was malformed"):
        asyncio.run(OllamaVisualAdapter().assess(b"image", "image/png"))


def test_malformed_tags_json_is_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/show"):
            return httpx.Response(200, json={}, request=request)
        if request.url.path.endswith("/api/tags"):
            return httpx.Response(200, content=b"not-json", request=request)
        if request.url.path.endswith("/api/chat"):
            return httpx.Response(200, json={"message": {"content": "{}"}}, request=request)
        raise AssertionError(f"unexpected request: {request.url}")

    _patch_transport(monkeypatch, handler)
    with pytest.raises(OllamaUnavailable, match="Ollama response JSON was malformed"):
        asyncio.run(OllamaVisualAdapter().assess(b"image", "image/png"))


def test_missing_allowlisted_digest_is_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/show"):
            return httpx.Response(200, json={}, request=request)
        if request.url.path.endswith("/api/tags"):
            return httpx.Response(200, json={"models": [{"name": "qwen3-vl:8b", "digest": "sha256:unapproved"}]}, request=request)
        if request.url.path.endswith("/api/chat"):
            return httpx.Response(200, json={"message": {"content": "{}"}}, request=request)
        raise AssertionError(f"unexpected request: {request.url}")

    _patch_transport(monkeypatch, handler)
    with pytest.raises(OllamaUnavailable, match="absent or not allowlisted"):
        asyncio.run(OllamaVisualAdapter().assess(b"image", "image/png"))


def test_malformed_chat_json_is_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)
    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/show"):
            return httpx.Response(200, json={"details": {"digest": "sha256:approved"}}, request=request)
        if request.url.path.endswith("/api/tags"):
            return httpx.Response(200, json={"models": []}, request=request)
        if request.url.path.endswith("/api/chat"):
            return httpx.Response(200, content=b"not-json", request=request)
        raise AssertionError(f"unexpected request: {request.url}")
    _patch_transport(monkeypatch, handler)
    with pytest.raises(OllamaUnavailable, match="Ollama response JSON was malformed"):
        asyncio.run(OllamaVisualAdapter().assess(b"image", "image/png"))


def test_invalid_structured_chat_content_is_fail_closed(monkeypatch: pytest.MonkeyPatch) -> None:
    _configure(monkeypatch)

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path.endswith("/api/show"):
            return httpx.Response(200, json={"details": {"digest": "sha256:approved"}}, request=request)
        if request.url.path.endswith("/api/tags"):
            return httpx.Response(200, json={"models": []}, request=request)
        if request.url.path.endswith("/api/chat"):
            return httpx.Response(200, json={"message": {"content": "{invalid-json"}}, request=request)
        raise AssertionError(f"unexpected request: {request.url}")

    _patch_transport(monkeypatch, handler)
    with pytest.raises(OllamaUnavailable, match="strict schema validation"):
        asyncio.run(OllamaVisualAdapter().assess(b"image", "image/png"))
