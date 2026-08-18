from __future__ import annotations

import base64
import json
import os
from hashlib import sha256

import httpx

from .contracts import EvidenceSignal, OllamaVisualAssessment


class OllamaUnavailable(RuntimeError):
    pass


class OllamaVisualAdapter:
    """Fail-closed Qwen-VL adapter. It never turns model output into a KYC/KYB decision."""

    def __init__(self) -> None:
        self.base_url = os.environ.get("OLLAMA_BASE_URL", "").rstrip("/")
        self.model = os.environ.get("OLLAMA_VISION_MODEL", "qwen3-vl:8b")
        self.timeout_seconds = float(os.environ.get("OLLAMA_TIMEOUT_SECONDS", "45"))
        self.max_image_bytes = int(os.environ.get("OLLAMA_MAX_IMAGE_BYTES", str(8 * 1024 * 1024)))

    async def assess(self, image_bytes: bytes, mime_type: str) -> tuple[OllamaVisualAssessment, str | None]:
        if not self.base_url:
            raise OllamaUnavailable("OLLAMA_BASE_URL is not configured")
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
            async with httpx.AsyncClient(timeout=self.timeout_seconds) as client:
                model_info = await client.post(f"{self.base_url}/api/show", json={"name": self.model})
                model_info.raise_for_status()
                chat = await client.post(f"{self.base_url}/api/chat", json=payload)
                chat.raise_for_status()
        except (httpx.HTTPError, ValueError) as exc:
            raise OllamaUnavailable(f"Ollama request failed: {exc}") from exc

        digest = model_info.json().get("details", {}).get("digest") or model_info.json().get("digest")
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
