from dataclasses import dataclass
from enum import Enum


class NormalizedStatus(str, Enum):
    SUBMITTED = "submitted"
    PENDING = "pending"
    SETTLED = "settled"
    FAILED = "failed"
    UNKNOWN = "unknown"


@dataclass(frozen=True)
class YellowCardResult:
    reference: str
    sequence_id: str
    status: NormalizedStatus
    retryable_without_business_effect: bool
    reason: str


def normalize_yellowcard_status(reference: str, sequence_id: str, raw_status: str) -> YellowCardResult:
    value = raw_status.strip().lower()
    if value in {"complete", "completed", "settled", "success", "successful"}:
        return YellowCardResult(reference, sequence_id, NormalizedStatus.SETTLED, False, "Yellow Card independently reported a completed send")
    if value in {"created", "accepted", "processing", "pending", "in_progress", "awaiting_approval"}:
        return YellowCardResult(reference, sequence_id, NormalizedStatus.PENDING, False, "Yellow Card send remains provisional")
    if value in {"expired", "cancelled", "canceled", "rejected"}:
        return YellowCardResult(reference, sequence_id, NormalizedStatus.FAILED, True, "Yellow Card explicitly reported a non-executed send")
    return YellowCardResult(reference, sequence_id, NormalizedStatus.UNKNOWN, False, "Yellow Card status is not safe to classify")
