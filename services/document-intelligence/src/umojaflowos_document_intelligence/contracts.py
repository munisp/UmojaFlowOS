from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, field_validator


class CaseKind(StrEnum):
    KYC = "kyc"
    KYB = "kyb"


class AnalysisDisposition(StrEnum):
    REVIEW_REQUIRED = "review_required"
    INSUFFICIENT_EVIDENCE = "insufficient_evidence"
    UNAVAILABLE = "unavailable"


class DocumentType(StrEnum):
    IDENTITY_DOCUMENT = "identity_document"
    PROOF_OF_ADDRESS = "proof_of_address"
    SOURCE_OF_FUNDS = "source_of_funds"
    SELFIE_OR_CAPTURE = "selfie_or_capture"
    REGISTRATION_CERTIFICATE = "registration_certificate"
    CONSTITUTIONAL_DOCUMENT = "constitutional_document"
    BENEFICIAL_OWNERSHIP = "beneficial_ownership"
    OPERATING_LICENCE = "operating_licence"
    BUSINESS_ADDRESS = "business_address"
    BANK_EVIDENCE = "bank_evidence"
    OTHER = "other"


class AnalysisRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    case_kind: CaseKind
    document_type: DocumentType
    consent_reference: str = Field(min_length=8, max_length=256)
    source_uri: HttpUrl
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    mime_type: str = Field(pattern=r"^(application/pdf|image/(jpeg|png|webp|tiff))$")
    filename: str = Field(min_length=1, max_length=255)
    submitted_at: datetime

    @field_validator("consent_reference")
    @classmethod
    def no_whitespace_only_consent(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("consent_reference must not be blank")
        return value.strip()


class EvidenceSignal(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(pattern=r"^[a-z0-9_]{3,80}$")
    severity: Literal["informational", "low", "medium", "high"]
    rationale: str = Field(min_length=1, max_length=1200)
    provenance: Literal["ocr", "docling", "ollama_vlm", "image_integrity", "specialized_pad", "specialized_deepfake"]


class EngineProvenance(BaseModel):
    model_config = ConfigDict(extra="forbid")

    engine: str
    version: str
    model_tag: str | None = None
    model_digest: str | None = None


class DocumentAnalysisResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    disposition: AnalysisDisposition
    review_required: Literal[True]
    source_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
    extracted_text_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    document_structure_sha256: str | None = Field(default=None, pattern=r"^[a-f0-9]{64}$")
    signals: list[EvidenceSignal]
    engines: list[EngineProvenance]
    limitations: list[str] = Field(min_length=1)
    analyzed_at: datetime


class OllamaVisualAssessment(BaseModel):
    """The only accepted VLM response; it cannot encode an approval or rejection."""

    model_config = ConfigDict(extra="forbid")

    visual_consistency: Literal["consistent", "inconsistent", "insufficient_evidence"]
    presentation_attack_risk: Literal["not_observed", "review_signal", "insufficient_evidence"]
    signals: list[EvidenceSignal]
    limitations: list[str] = Field(min_length=1)
