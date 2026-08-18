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


class DeepfakeEvidenceError(ValueError):
    pass


def build_review_only_deepfake_evidence(
    request: AnalysisRequest,
    signals: list[EvidenceSignal],
    engine: EngineProvenance,
) -> DocumentAnalysisResult:
    """Preserve specialist deepfake-risk evidence without making an identity decision.

    The caller must pass only consented selfie/capture or identity-document imagery
    and provenance from a trusted specialist engine. The boundary intentionally
    cannot produce approval, rejection, adverse action, or payment authorisation.
    """

    if request.document_type not in {DocumentType.SELFIE_OR_CAPTURE, DocumentType.IDENTITY_DOCUMENT}:
        raise DeepfakeEvidenceError("deepfake evidence is limited to authorised selfie or identity-document imagery")
    if not engine.engine.strip() or not engine.version.strip():
        raise DeepfakeEvidenceError("specialized deepfake engine provenance and version are required")
    if not signals:
        raise DeepfakeEvidenceError("deepfake evidence requires at least one specialised signal")
    if any(signal.provenance != "specialized_deepfake" for signal in signals):
        raise DeepfakeEvidenceError("deepfake workflow accepts only specialized_deepfake evidence signals")

    return DocumentAnalysisResult(
        disposition=AnalysisDisposition.REVIEW_REQUIRED,
        review_required=True,
        source_sha256=request.source_sha256,
        signals=signals,
        engines=[engine],
        limitations=[
            "Deepfake-risk evidence is non-decisional and requires trained human review.",
            "No identity approval, rejection, adverse action, or payment authorisation is produced by this workflow.",
        ],
        analyzed_at=datetime.now(timezone.utc),
    )
