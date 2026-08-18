from __future__ import annotations

import base64
import json
import os
from hashlib import sha256
from urllib.parse import urlparse

import httpx

from .contracts import EvidenceSignal, OllamaVisualAssessment


class OllamaUnavailable(RuntimeError):
    pass


class OllamaVisualAdapter:
    """Fail-closed Qwen-VL adapter. It never turns model output into a KYC/KYB decision."""

    def __init__(self) -> None:
        self.base_url = os.environ.get("OLLAMA_BASE_URL", "").rstrip("/")
        self.model = os.environ.get("OLLAMA_VISION_MODEL", "qwen3-vl:8b")
        self.allowed_models = {model.strip() for model in os.environ.get("OLLAMA_ALLOWED_VISION_MODELS", "qwen3-vl:8b").split(",") if model.strip()}
        self.allowed_digests = {digest.strip() for digest in os.environ.get("OLLAMA_ALLOWED_MODEL_DIGESTS", "").split(",") if digest.strip()}
        self.mtls_cert_file = os.environ.get("OLLAMA_MTLS_CERT_FILE")
        self.mtls_key_file = os.environ.get("OLLAMA_MTLS_KEY_FILE")
        self.tls_ca_file = os.environ.get("OLLAMA_TLS_CA_FILE")
        self.timeout_seconds = float(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "45"))
        self.max_image_bytes = int(os.environ.get("OLLAMA_MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))

    def validate_activation_configuration(self) -> None:
        if not self.base_url:
            raise OllamaUnavailable("OLLAMA_BASE_URL is not configured")
        parsed = urlparse(self.base_url)
        hostname = (parsed.hostname or "").lower()
        private_host = hostname in {"localhost", "127.0.0.1", "::1"} or hostname.endswith(".internal") or hostname.endswith(".local")
        if parsed.scheme != "https" and not private_host:
            raise OllamaUnavailable("Ollama endpoint must use HTTPS unless it is an explicitly private local hostname")
        if not private_host:
            raise OllamaUnavailable("Ollama endpoint must be a private or internal hostname; public ingress is prohibited")
        if hostname not in {"localhost", "127.0.0.1", "::1"} and not self.tls_ca_file:
            raise OllamaUnavailable("Non-local Ollama endpoints require OLLAMA_TLS_CA_FILE for certificate verification")
        if self.model not in self.allowed_models or self.model.endswith(":latest"):
            raise OllamaUnavailable("Ollama visual evidence requires an exact allowlisted Qwen3-VL model tag")
        if not self.allowed_digests:
            raise OllamaUnavailable("OLLAMA_ALLOWED_MODEL_DIGESTS must contain the verified model digest")
        if bool(self.mtls_cert_file) != bool(self.mtls_key_file):
            raise OllamaUnavailable("mTLS requires both OLLAMA_MTLS_CERT_FILE and OLLAMA_MTLS_KEY_FILE")

    async def assess(self, image_bytes: bytes, mime_type: str) -> tuple[OllamaVisualAssessment, str | None]:
        self.validate_activation_configuration()
        if len(image_bytes) > self.max_image_bytes:
            raise OllamaUnavailable("image exceeds configured Ollama visual-analysis limit")
        if mime_type not in {"image/jpeg", "image/png", "image/webp", "image/tiff"}:
            raise OllamaUnavailable("Ollama visual analysis supports image inputs only")

        schema = OllamaVisualAssessment.model_json_schema()
        prompt = (
            "You analyse KYC or KYB document imagery for review-required evidence only. "
            "Do not approve, reject, identify a person, infer protected traits, or claim liveness. "
            "Assess visible document coherence and possible presentation-attack risk signals. "
            "If evidence is weak, use insufficient_evidence and state the limitation. Return only JSON matching the schema."
        )
        payload = {
            "model": self.model,
            "stream": False,
            "format": schema,
            "options": {"temperature": 0},
            "messages": [{"role": "user", "content": prompt, "images": [base64.b64encode(image_bytes).decode("ascii")]}],
        }
        try:
            client_options: dict[str, object] = {"timeout": self.timeout_seconds}
            if self.tls_ca_file:
                client_options["verify"] = self.tls_ca_file
            if self.mtls_cert_file and self.mtls_key_file:
                client_options["cert"] = (self.mtls_cert_file, self.mtls_key_file)
            async with httpx.AsyncClient(**client_options) as client:
                model_info = await client.post(f"{self.base_url}/api/show", json={"name": self.model})
                model_info.raise_for_status()
                chat = await client.post(f"{self.base_url}/api/chat", json=payload)
                chat.raise_for_status()
        except (httpx.HTTPError, ValueError) as exc:
            raise OllamaUnavailable(f"Ollama request failed: {exc}") from exc

        digest = model_info.json().get("details", {}).get("digest") or model_info.json().get("digest")
        if not isinstance(digest, str) or digest not in self.allowed_digests:
            raise OllamaUnavailable("Ollama model digest is absent or not allowlisted")
        content = chat.json().get("message", {}).get("content")
        if not isinstance(content, str):
            raise OllamaUnavailable("Ollama returned no structured analysis content")
        try:
            assessment = OllamaVisualAssessment.model_validate_json(content)
        except ValueError as exc:
            raise OllamaUnavailable(f"Ollama response failed strict schema validation: {exc}") from exc
        return assessment, digest


def unavailable_signal(reason: str) -> EvidenceSignal:
    return EvidenceSignal(code="visual_analysis_unavailable", severity="medium", rationale=reason, provenance="ollama_vlm")
