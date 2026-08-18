from __future__ import annotations

import hashlib
import importlib.metadata
import json
from datetime import UTC, datetime
from pathlib import Path

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from pydantic import ValidationError

from .contracts import AnalysisDisposition, AnalysisRequest, DocumentAnalysisResult, EngineProvenance, EvidenceSignal
from .ollama_adapter import OllamaUnavailable, OllamaVisualAdapter, unavailable_signal

app = FastAPI(title="UmojaFlowOS Document Intelligence", version="0.1.0")


def _sha256(value: bytes | str) -> str:
    data = value.encode("utf-8") if isinstance(value, str) else value
    return hashlib.sha256(data).hexdigest()


def _ensure_content_matches_claim(content: bytes, request: AnalysisRequest) -> None:
    actual = _sha256(content)
    if actual != request.source_sha256:
        raise HTTPException(status_code=422, detail="document SHA-256 does not match the declared source hash")


def _paddle_extract(path: Path) -> tuple[str, list[EvidenceSignal], EngineProvenance]:
    try:
        from paddleocr import PaddleOCR
    except ImportError as exc:
        raise RuntimeError("PaddleOCR is unavailable") from exc
    ocr = PaddleOCR(lang="en")
    result = ocr.predict(str(path))
    text_fragments: list[str] = []
    for page in result:
        payload = page.json if hasattr(page, "json") else page
        text_fragments.append(json.dumps(payload, sort_keys=True, default=str))
    return "\n".join(text_fragments), [], EngineProvenance(engine="PaddleOCR", version=importlib.metadata.version("paddleocr"))


def _docling_extract(path: Path) -> tuple[str, EngineProvenance]:
    try:
        from docling.document_converter import DocumentConverter
    except ImportError as exc:
        raise RuntimeError("Docling is unavailable") from exc
    converted = DocumentConverter().convert(str(path))
    markdown = converted.document.export_to_markdown()
    return markdown, EngineProvenance(engine="Docling", version=importlib.metadata.version("docling"))


async def _analyse_file(request: AnalysisRequest, content: bytes) -> DocumentAnalysisResult:
    suffix = Path(request.filename).suffix or ".bin"
    workspace = Path("/tmp/umojaflowos-document-intelligence")
    workspace.mkdir(mode=0o700, parents=True, exist_ok=True)
    path = workspace / f"{request.source_sha256}{suffix}"
    path.write_bytes(content)
    engines: list[EngineProvenance] = []
    signals: list[EvidenceSignal] = []
    limitations: list[str] = ["Analysis is review-required evidence and is not an identity, business, liveness, or submission decision."]
    extracted_text: str | None = None
    structure: str | None = None

    try:
        extracted_text, ocr_signals, provenance = _paddle_extract(path)
        signals.extend(ocr_signals)
        engines.append(provenance)
    except RuntimeError as exc:
        signals.append(EvidenceSignal(code="ocr_unavailable", severity="medium", rationale=str(exc), provenance="ocr"))
        limitations.append("OCR was unavailable; human review is required.")

    try:
        structure, provenance = _docling_extract(path)
        engines.append(provenance)
    except RuntimeError as exc:
        signals.append(EvidenceSignal(code="document_parser_unavailable", severity="medium", rationale=str(exc), provenance="docling"))
        limitations.append("Document structure parsing was unavailable; human review is required.")

    if request.mime_type.startswith("image/"):
        try:
            assessment, digest = await OllamaVisualAdapter().assess(content, request.mime_type)
            signals.extend(assessment.signals)
            limitations.extend(assessment.limitations)
            engines.append(EngineProvenance(engine="Ollama", version="api", model_tag=OllamaVisualAdapter().model, model_digest=digest))
        except OllamaUnavailable as exc:
            signals.append(unavailable_signal(str(exc)))
            limitations.append("Visual analysis was unavailable; no presentation-attack conclusion was made.")
    else:
        limitations.append("Visual analysis was not attempted because the input was not an image.")

    disposition = AnalysisDisposition.REVIEW_REQUIRED if engines else AnalysisDisposition.UNAVAILABLE
    if not extracted_text and not structure and not engines:
        disposition = AnalysisDisposition.UNAVAILABLE
    return DocumentAnalysisResult(
        disposition=disposition,
        review_required=True,
        source_sha256=request.source_sha256,
        extracted_text_sha256=_sha256(extracted_text) if extracted_text else None,
        document_structure_sha256=_sha256(structure) if structure else None,
        signals=signals,
        engines=engines,
        limitations=list(dict.fromkeys(limitations)),
        analyzed_at=datetime.now(UTC),
    )


@app.get("/healthz")
async def healthz() -> dict[str, str]:
    return {"status": "ok", "service": "document-intelligence"}


@app.post("/v1/analyse", response_model=DocumentAnalysisResult)
async def analyse_document(
    request_json: str = Header(alias="x-umojaflowos-analysis-request"),
    document: UploadFile = File(),
) -> DocumentAnalysisResult:
    try:
        request = AnalysisRequest.model_validate_json(request_json)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=exc.errors()) from exc
    if document.content_type != request.mime_type:
        raise HTTPException(status_code=422, detail="uploaded MIME type does not match declared MIME type")
    content = await document.read()
    _ensure_content_matches_claim(content, request)
    return await _analyse_file(request, content)
