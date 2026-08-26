from datetime import datetime, timedelta, timezone

import pytest

from simulators.retention_gateway.decision_engine import (
    ApprovalResult,
    DeleteRequest,
    DecisionCode,
    HMACAuthorizationSigner,
    HoldResult,
    InMemoryDecisionStore,
    RetentionDecisionEngine,
    WormResult,
)
from simulators.retention_gateway.delete_worker import (
    DatabaseConnectionPoolError,
    DeleteWorker,
    HMACAuthorizationVerifier,
    IndexIdentity,
    InMemoryAuthorizationUseStore,
)

NOW = datetime(2026, 8, 25, 12, 0, tzinfo=timezone.utc)
DIGEST = "a" * 64


class Holds:
    def __init__(self, result=None, error=None): self.result, self.error = result, error
    def check(self, request):
        if self.error: raise RuntimeError(self.error)
        return self.result


class Worm:
    def __init__(self, result=None, error=None): self.result, self.error = result, error
    def verify(self, request):
        if self.error: raise RuntimeError(self.error)
        return self.result


class Approvals:
    def __init__(self, result=None, error=None): self.result, self.error = result, error
    def check(self, request, worm):
        if self.error: raise RuntimeError(self.error)
        return self.result


def request():
    return DeleteRequest("umoja-security-audit-v1-000001", "uuid-1", "7", DIGEST, "ism-service", "corr-1")


def engine(hold=None, worm=None, approval=None, store=None, hold_error=None, worm_error=None, approval_error=None):
    return RetentionDecisionEngine(
        Holds(hold or HoldResult("clear"), hold_error),
        Worm(worm or WormResult(True, NOW - timedelta(minutes=1), "obj-1", DIGEST, True, True), worm_error),
        Approvals(approval or ApprovalResult(True, "independent-reviewer", "approval-1"), approval_error),
        store or InMemoryDecisionStore(),
        HMACAuthorizationSigner(b"s" * 32),
    )


def test_authorizes_only_when_all_evidence_is_valid():
    result = engine().decide(request(), NOW)
    assert result.code is DecisionCode.AUTHORIZED
    assert result.http_status == 202
    assert result.authorization_token
    assert result.evidence["approver"] == "independent-reviewer"


def test_active_hold_denies():
    result = engine(hold=HoldResult("active", ("hold-1",), "matter hold")).decide(request(), NOW)
    assert result.code is DecisionCode.HOLD_ACTIVE
    assert result.http_status == 409


def test_unknown_hold_state_denies():
    result = engine(hold=HoldResult("unknown", reason="hold registry timeout")).decide(request(), NOW)
    assert result.code is DecisionCode.HOLD_ACTIVE


@pytest.mark.parametrize("worm", [
    WormResult(False, NOW - timedelta(minutes=1), "obj-1", DIGEST, True, True, "archive unavailable"),
    WormResult(True, NOW - timedelta(minutes=1), "obj-1", DIGEST, False, True, "signature invalid"),
    WormResult(True, NOW - timedelta(minutes=1), "obj-1", DIGEST, True, False, "incomplete archive"),
    WormResult(True, NOW + timedelta(minutes=1), "obj-1", DIGEST, True, True, "retention active"),
    WormResult(True, NOW - timedelta(minutes=1), "obj-1", "b" * 64, True, True, "wrong digest"),
])
def test_worm_failures_deny(worm):
    result = engine(worm=worm).decide(request(), NOW)
    assert result.code is DecisionCode.WORM_NOT_VERIFIED
    assert result.http_status == 412


def test_provider_outage_is_fail_closed():
    assert engine(hold_error="down").decide(request(), NOW).code is DecisionCode.VERIFICATION_ERROR
    assert engine(worm_error="down").decide(request(), NOW).code is DecisionCode.VERIFICATION_ERROR
    assert engine(approval_error="down").decide(request(), NOW).code is DecisionCode.VERIFICATION_ERROR


def test_self_approval_denies():
    result = engine(approval=ApprovalResult(True, "ism-service", "approval-1")).decide(request(), NOW)
    assert result.code is DecisionCode.APPROVAL_REQUIRED
    assert result.http_status == 409


def test_missing_scope_denies():
    bad = DeleteRequest("", "uuid-1", "7", DIGEST, "ism-service", "corr-1")
    assert engine().decide(bad, NOW).code is DecisionCode.SCOPE_AMBIGUOUS


def test_repeat_request_is_idempotent():
    store = InMemoryDecisionStore()
    first = engine(store=store).decide(request(), NOW)
    second = engine(store=store).decide(request(), NOW + timedelta(seconds=1))
    assert first.code is DecisionCode.AUTHORIZED
    assert second.code is DecisionCode.ALREADY_DELETED
    assert second.decision_digest == first.decision_digest


class FakeOpenSearch:
    def __init__(self, identity):
        self.current = identity
        self.delete_calls = []

    def identity(self, index):
        return self.current if self.current and self.current.index == index else None

    def delete_exact_index(self, index, expected_uuid, expected_version):
        self.delete_calls.append((index, expected_uuid, expected_version))
        self.current = None
        return True


def worker_for(req=None):
    req = req or request()
    decision = engine().decide(req, NOW)
    opensearch = FakeOpenSearch(IndexIdentity(req.index, req.index_uuid, req.index_version, req.expected_digest))
    worker = DeleteWorker(
        HMACAuthorizationVerifier(b"s" * 32),
        InMemoryAuthorizationUseStore(),
        opensearch,
    )
    return decision, worker, opensearch


def test_worker_rejects_expired_token():
    decision, worker, opensearch = worker_for()
    result = worker.execute(decision.authorization_token, request(), decision.decision_digest, NOW + timedelta(minutes=6))
    assert result == "denied_invalid_or_expired_token"
    assert opensearch.delete_calls == []


def test_worker_consumes_authorization_once():
    decision, worker, opensearch = worker_for()
    first = worker.execute(decision.authorization_token, request(), decision.decision_digest, NOW)
    second = worker.execute(decision.authorization_token, request(), decision.decision_digest, NOW + timedelta(seconds=1))
    assert first == "deleted"
    assert second == "denied_replay_or_consumed"
    assert len(opensearch.delete_calls) == 1


@pytest.mark.parametrize("field", ["index", "index_uuid", "index_version", "expected_digest"])
def test_worker_rejects_changed_request_scope(field):
    decision, worker, opensearch = worker_for()
    values = {
        "index": request().index,
        "index_uuid": request().index_uuid,
        "index_version": request().index_version,
        "expected_digest": request().expected_digest,
        "requested_by": request().requested_by,
        "correlation_id": request().correlation_id,
    }
    values[field] = values[field] + "-changed"
    changed = DeleteRequest(**values)
    result = worker.execute(decision.authorization_token, changed, decision.decision_digest, NOW)
    assert result == "denied_invalid_or_expired_token"
    assert opensearch.delete_calls == []


def test_worker_rejects_changed_current_index_identity():
    decision, worker, opensearch = worker_for()
    opensearch.current = IndexIdentity(request().index, "replacement-uuid", request().index_version, DIGEST)
    result = worker.execute(decision.authorization_token, request(), decision.decision_digest, NOW)
    assert result == "denied_scope_changed"
    assert opensearch.delete_calls == []


class SaturatedAuthorizationStore:
    def claim(self, decision_digest, expires_at, now):
        raise DatabaseConnectionPoolError("connection pool acquisition timed out")


def test_worker_fails_closed_when_postgres_pool_is_saturated():
    decision, _worker, opensearch = worker_for()
    worker = DeleteWorker(HMACAuthorizationVerifier(b"s" * 32), SaturatedAuthorizationStore(), opensearch)
    result = worker.execute(decision.authorization_token, request(), decision.decision_digest, NOW)
    assert result == "database_connection_pool_saturated"
    assert opensearch.delete_calls == []
