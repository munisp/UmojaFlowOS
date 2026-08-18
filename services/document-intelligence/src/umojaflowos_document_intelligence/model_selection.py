from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Literal


class ModelSelectionUnavailable(RuntimeError):
    pass


AnalysisModality = Literal["image", "text"]
ModelRole = Literal["visual_primary", "text_fallback"]


@dataclass(frozen=True)
class SelectedModel:
    tag: str
    digest: str
    role: ModelRole
    modality: AnalysisModality


_DIGEST = re.compile(r"^[a-f0-9]{64}$")
_EXPECTED = {
    "image": ("qwen3-vl:8b", "visual_primary"),
    "text": ("deepseek-r1:8b", "text_fallback"),
}


def select_review_only_model(modality: AnalysisModality, available_digests: dict[str, str]) -> SelectedModel:
    """Choose an exact, pinned model for evidence only; never create a disposition."""
    if modality not in _EXPECTED:
        raise ModelSelectionUnavailable("unsupported analysis modality")
    tag, role = _EXPECTED[modality]
    digest = available_digests.get(tag)
    if not isinstance(digest, str) or not _DIGEST.fullmatch(digest):
        raise ModelSelectionUnavailable(f"verified digest for {tag} is unavailable")
    return SelectedModel(tag=tag, digest=digest, role=role, modality=modality)
