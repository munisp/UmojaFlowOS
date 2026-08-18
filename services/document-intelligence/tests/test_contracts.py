from datetime import UTC, datetime
from hashlib import sha256

import pytest
from pydantic import ValidationError

from umojaflowos_document_intelligence.contracts import AnalysisDisposition, AnalysisRequest, CaseKind, DocumentType, EngineProvenance, EvidenceSignal, OllamaVisualAssessment
from umojaflowos_document_intelligence.pad import PadEvidenceError, build_review_only_pad_evidence
from umojaflowos_document_intelligence.deepfake import DeepfakeEvidenceError, build_review_only_deepfake_evidence


def test_analysis_request_requires_a_hash_matched_document_contract() -> None:
    request = AnalysisRequest(
        case_kind=CaseKind.KYC,
        document_type=DocumentType.IDENTITY_DOCUMENT,
        consent_reference="consent-reference-123",
        source_uri="https://storage.example.invalid/object",
        source_sha256=sha256(b"authorised-document").hexdigest(),
        mime_type="image/jpeg",
        filename="identity.jpg",
        submitted_at=datetime.now(UTC),
    )
    assert request.case_kind is CaseKind.KYC


def test_ollama_assessment_cannot_encode_an_approval_or_rejection() -> None:
    with pytest.raises(ValidationError):
        OllamaVisualAssessment.model_validate({
            "visual_consistency": "consistent",
            "presentation_attack_risk": "not_observed",
            "signals": [],
            "limitations": ["Human review remains required."],
            "decision": "approved",
        })


def test_presentation_attack_signal_remains_review_only_evidence() -> None:
    assessment = OllamaVisualAssessment.model_validate({
        "visual_consistency": "insufficient_evidence",
        "presentation_attack_risk": "review_signal",
        "signals": [{"code": "capture_anomaly", "severity": "medium", "rationale": "Visual anomaly requires human examination.", "provenance": "ollama_vlm"}],
        "limitations": ["This evidence is not a liveness determination or an automated adverse action."],
    })
    assert assessment.presentation_attack_risk == "review_signal"


def test_specialized_pad_evidence_is_review_only_for_authorised_identity_imagery() -> None:
    request = AnalysisRequest(
        case_kind=CaseKind.KYC,
        document_type=DocumentType.SELFIE_OR_CAPTURE,
        consent_reference="consent-reference-123",
        source_uri="https://storage.example.invalid/object",
        source_sha256="a" * 64,
        mime_type="image/jpeg",
        filename="authorised-selfie.jpg",
        submitted_at=datetime.now(UTC),
    )
    result = build_review_only_pad_evidence(
        request,
        [EvidenceSignal(code="capture_anomaly", severity="medium", rationale="Specialized engine detected a capture anomaly for reviewer examination.", provenance="specialized_pad")],
        EngineProvenance(engine="specialized-pad", version="v1"),
    )
    assert result.disposition is AnalysisDisposition.REVIEW_REQUIRED
    assert result.review_required is True
    assert "No identity approval" in result.limitations[1]


def test_pad_evidence_rejects_non_identity_imagery_and_untrusted_signal_provenance() -> None:
    request = AnalysisRequest(
        case_kind=CaseKind.KYB,
        document_type=DocumentType.REGISTRATION_CERTIFICATE,
        consent_reference="consent-reference-456",
        source_uri="https://storage.example.invalid/object",
        source_sha256="b" * 64,
        mime_type="image/png",
        filename="registration.png",
        submitted_at=datetime.now(UTC),
    )
    engine = EngineProvenance(engine="specialized-pad", version="v1")
    with pytest.raises(PadEvidenceError):
        build_review_only_pad_evidence(request, [], engine)

    authorized_request = request.model_copy(update={"document_type": DocumentType.IDENTITY_DOCUMENT})
    with pytest.raises(PadEvidenceError):
        build_review_only_pad_evidence(authorized_request, [EvidenceSignal(code="capture_anomaly", severity="low", rationale="Untrusted signal must be rejected.", provenance="ollama_vlm")], engine)


def test_deepfake_evidence_is_review_only_for_authorised_identity_imagery() -> None:
    request = AnalysisRequest(
        case_kind=CaseKind.KYC,
        document_type=DocumentType.IDENTITY_DOCUMENT,
        consent_reference="consent-reference-789",
        source_uri="https://storage.example.invalid/identity",
        source_sha256="c" * 64,
        mime_type="image/jpeg",
        filename="authorised-identity.jpg",
        submitted_at=datetime.now(UTC),
    )
    result = build_review_only_deepfake_evidence(
        request,
        [EvidenceSignal(code="synthetic_texture", severity="high", rationale="Specialised model signal requires reviewer examination.", provenance="specialized_deepfake")],
        EngineProvenance(engine="specialized-deepfake", version="v1", model_digest="sha256:approved"),
    )
    assert result.disposition is AnalysisDisposition.REVIEW_REQUIRED
    assert result.review_required is True
    assert "No identity approval" in result.limitations[1]


def test_deepfake_evidence_rejects_non_identity_imagery_and_untrusted_provenance() -> None:
    request = AnalysisRequest(
        case_kind=CaseKind.KYB,
        document_type=DocumentType.REGISTRATION_CERTIFICATE,
        consent_reference="consent-reference-987",
        source_uri="https://storage.example.invalid/registration",
        source_sha256="d" * 64,
        mime_type="image/png",
        filename="registration.png",
        submitted_at=datetime.now(UTC),
    )
    engine = EngineProvenance(engine="specialized-deepfake", version="v1")
    with pytest.raises(DeepfakeEvidenceError):
        build_review_only_deepfake_evidence(request, [EvidenceSignal(code="synthetic_texture", severity="medium", rationale="Must not accept non-identity imagery.", provenance="specialized_deepfake")], engine)

    authorized_request = request.model_copy(update={"document_type": DocumentType.SELFIE_OR_CAPTURE})
    with pytest.raises(DeepfakeEvidenceError):
        build_review_only_deepfake_evidence(authorized_request, [EvidenceSignal(code="synthetic_texture", severity="medium", rationale="Untrusted provenance must be rejected.", provenance="ollama_vlm")], engine)
