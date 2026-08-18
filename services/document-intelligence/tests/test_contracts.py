from datetime import UTC, datetime
from hashlib import sha256

import pytest
from pydantic import ValidationError

from umojaflowos_document_intelligence.contracts import AnalysisRequest, CaseKind, DocumentType, OllamaVisualAssessment


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
