from __future__ import annotations

from datetime import datetime, timezone

from .contracts import (
    AnalysisDisposition,
    AnalysisRequest,
    DocumentAnalysisResult,
    DocumentType,
    EngineProvenance,
    EvidenceSignal,
)


class PadEvidenceError(ValueError):
    pass


def build_review_only_pad_evidence(
    request: AnalysisRequest,
    signals: list[EvidenceSignal],
    engine: EngineProvenance,
) -> DocumentAnalysisResult:
    """Preserve specialized PAD evidence while prohibiting automated identity decisions.

    The caller must supply evidence from an approved specialised engine after the
    request's consent and source integrity checks have passed. This function does
    not inspect images, infer identity, or downgrade the mandatory human review.
    """

    if request.document_type not in {DocumentType.SELFIE_OR_CAPTURE, DocumentType.IDENTITY_DOCUMENT}:
        raise PadEvidenceError("PAD evidence is limited to authorised selfie or identity-document imagery")
    if engine.engine.strip() == "":
        raise PadEvidenceError("specialized PAD engine provenance is required")
    if any(signal.provenance != "specialized_pad" for signal in signals):
        raise PadEvidenceError("PAD workflow accepts only specialized_pad evidence signals")

    return DocumentAnalysisResult(
        disposition=AnalysisDisposition.REVIEW_REQUIRED,
        review_required=True,
        source_sha256=request.source_sha256,
        signals=signals,
        engines=[engine],
        limitations=[
            "Presentation-attack evidence is non-decisional and requires trained human review.",
            "No identity approval, rejection, or payment authorization is produced by this workflow.",
        ],
        analyzed_at=datetime.now(timezone.utc),
    )
