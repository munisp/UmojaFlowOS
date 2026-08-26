"""Fail-closed deletion authorization engine for OpenSearch ISM callbacks.

This module deliberately separates deletion *authorization* from deletion execution.
A caller receives an authorization only when every mandatory evidence provider returns
an affirmative result for the exact physical index and version being deleted.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from enum import Enum
from hashlib import sha256
import hmac
import json
from typing import Protocol


class DecisionCode(str, Enum):
    AUTHORIZED = "authorized"
    HOLD_ACTIVE = "hold_active"
    WORM_NOT_VERIFIED = "worm_not_verified"
    APPROVAL_REQUIRED = "approval_required"
    SCOPE_AMBIGUOUS = "scope_ambiguous"
    VERIFICATION_ERROR = "verification_error"
    ALREADY_DELETED = "already_deleted"


@dataclass(frozen=True)
class DeleteRequest:
    index: str
    index_uuid: str
    index_version: str
    expected_digest: str
    requested_by: str
    correlation_id: str


@dataclass(frozen=True)
class HoldResult:
    status: str
    hold_ids: tuple[str, ...] = ()
    reason: str = ""


@dataclass(frozen=True)
class WormResult:
    verified: bool
    retain_until: datetime | None = None
    object_version: str = ""
    archive_digest: str = ""
    signature_valid: bool = False
    complete: bool = False
    reason: str = ""


@dataclass(frozen=True)
class ApprovalResult:
    approved: bool
    approver: str = ""
    decision_digest: str = ""
    reason: str = ""


@dataclass(frozen=True)
class Decision:
    code: DecisionCode
    http_status: int
    reason: str
    correlation_id: str
    decision_digest: str
    authorization_token: str = ""
    evidence: dict[str, object] = field(default_factory=dict)


class HoldProvider(Protocol):
    def check(self, request: DeleteRequest) -> HoldResult: ...


class WormProvider(Protocol):
    def verify(self, request: DeleteRequest) -> WormResult: ...


class ApprovalProvider(Protocol):
    def check(self, request: DeleteRequest, worm: WormResult) -> ApprovalResult: ...


class DecisionStore(Protocol):
    def get(self, request: DeleteRequest) -> Decision | None: ...
    def put(self, request: DeleteRequest, decision: Decision) -> None: ...


class InMemoryDecisionStore:
    def __init__(self) -> None:
        self._items: dict[tuple[str, str, str], Decision] = {}

    def get(self, request: DeleteRequest) -> Decision | None:
        return self._items.get((request.index, request.index_uuid, request.index_version))

    def put(self, request: DeleteRequest, decision: Decision) -> None:
        self._items[(request.index, request.index_uuid, request.index_version)] = decision


class HMACAuthorizationSigner:
    def __init__(self, secret: bytes) -> None:
        if len(secret) < 32:
            raise ValueError("authorization signing secret must be at least 32 bytes")
        self.secret = secret

    def sign(self, request: DeleteRequest, decision_digest: str, expires_at: datetime) -> str:
        body = {
            "index": request.index,
            "index_uuid": request.index_uuid,
            "index_version": request.index_version,
            "expected_digest": request.expected_digest,
            "decision_digest": decision_digest,
            "expires_at": expires_at.astimezone(timezone.utc).isoformat(),
        }
        canonical = json.dumps(body, sort_keys=True, separators=(",", ":")).encode()
        signature = hmac.new(self.secret, canonical, sha256).hexdigest()
        return f"{signature}.{body['expires_at']}"


class RetentionDecisionEngine:
    def __init__(
        self,
        holds: HoldProvider,
        worm: WormProvider,
        approvals: ApprovalProvider,
        store: DecisionStore,
        signer: HMACAuthorizationSigner,
        authorization_ttl_seconds: int = 300,
    ) -> None:
        if authorization_ttl_seconds <= 0:
            raise ValueError("authorization TTL must be positive")
        self.holds = holds
        self.worm = worm
        self.approvals = approvals
        self.store = store
        self.signer = signer
        self.authorization_ttl_seconds = authorization_ttl_seconds

    def decide(self, request: DeleteRequest, now: datetime | None = None) -> Decision:
        now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if not request.index or not request.index_uuid or not request.index_version:
            return self._deny(DecisionCode.SCOPE_AMBIGUOUS, 422, "exact physical index identity is required", request)
        if not request.expected_digest or not request.correlation_id:
            return self._deny(DecisionCode.SCOPE_AMBIGUOUS, 422, "digest and correlation_id are required", request)

        prior = self.store.get(request)
        if prior is not None:
            return Decision(DecisionCode.ALREADY_DELETED, 200, "decision already recorded", request.correlation_id, prior.decision_digest, evidence=prior.evidence)

        try:
            hold = self.holds.check(request)
        except Exception as exc:
            return self._deny(DecisionCode.VERIFICATION_ERROR, 503, f"hold provider unavailable: {exc}", request)
        if hold.status != "clear":
            return self._deny(DecisionCode.HOLD_ACTIVE, 409, hold.reason or "active or unknown hold state", request, {"hold_ids": hold.hold_ids, "hold_status": hold.status})

        try:
            worm = self.worm.verify(request)
        except Exception as exc:
            return self._deny(DecisionCode.VERIFICATION_ERROR, 503, f"WORM provider unavailable: {exc}", request)
        if not worm.verified or not worm.signature_valid or not worm.complete:
            return self._deny(DecisionCode.WORM_NOT_VERIFIED, 412, worm.reason or "WORM evidence is incomplete", request, {"object_version": worm.object_version, "signature_valid": worm.signature_valid, "complete": worm.complete})
        if worm.archive_digest != request.expected_digest:
            return self._deny(DecisionCode.WORM_NOT_VERIFIED, 412, "archive digest does not match requested index digest", request, {"archive_digest": worm.archive_digest})
        if worm.retain_until is None or worm.retain_until.astimezone(timezone.utc) > now:
            return self._deny(DecisionCode.WORM_NOT_VERIFIED, 412, "WORM retention has not expired", request, {"retain_until": worm.retain_until.isoformat() if worm.retain_until else None})

        try:
            approval = self.approvals.check(request, worm)
        except Exception as exc:
            return self._deny(DecisionCode.VERIFICATION_ERROR, 503, f"approval provider unavailable: {exc}", request)
        if not approval.approved or approval.approver == request.requested_by:
            return self._deny(DecisionCode.APPROVAL_REQUIRED, 409, approval.reason or "independent deletion approval is required", request, {"approver": approval.approver})

        digest = self._digest(request, hold, worm, approval)
        expires_at = now.timestamp() + self.authorization_ttl_seconds
        expiry = datetime.fromtimestamp(expires_at, timezone.utc)
        token = self.signer.sign(request, digest, expiry)
        decision = Decision(DecisionCode.AUTHORIZED, 202, "all deletion checks passed", request.correlation_id, digest, token, {"approver": approval.approver, "object_version": worm.object_version, "expires_at": expiry.isoformat()})
        self.store.put(request, decision)
        return decision

    def _deny(self, code: DecisionCode, status: int, reason: str, request: DeleteRequest, evidence: dict[str, object] | None = None) -> Decision:
        digest = sha256(f"{request.correlation_id}|{code.value}|{reason}".encode()).hexdigest()
        return Decision(code, status, reason, request.correlation_id, digest, evidence=evidence or {})

    @staticmethod
    def _digest(request: DeleteRequest, hold: HoldResult, worm: WormResult, approval: ApprovalResult) -> str:
        payload = {
            "request": request.__dict__,
            "holds": hold.__dict__,
            "worm": {"object_version": worm.object_version, "archive_digest": worm.archive_digest, "retain_until": worm.retain_until.isoformat() if worm.retain_until else None, "signature_valid": worm.signature_valid, "complete": worm.complete},
            "approval": approval.__dict__,
        }
        return sha256(json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
