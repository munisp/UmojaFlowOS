from __future__ import annotations

import base64
import hashlib
import hmac
import os
import time
from collections import OrderedDict
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field

app = FastAPI(title="UmojaFlowOS production dependency simulator", version="1.0.0")

LEDGER: dict[str, dict[str, Any]] = {}
REPLAY_CACHE: OrderedDict[str, float] = OrderedDict()
AML_BLOCKED = {"blocked@example.test", "sanctions@example.test"}
WEBHOOK_SECRET = os.environ.get("SIMULATOR_WEBHOOK_SECRET", "ci-simulator-secret").encode()
REPLAY_WINDOW_SECONDS = int(os.environ.get("SIMULATOR_REPLAY_WINDOW_SECONDS", "300"))


def now() -> datetime:
    return datetime.now(timezone.utc)


def cleanup_replay_cache(current: float) -> None:
    while REPLAY_CACHE:
        key, expiry = next(iter(REPLAY_CACHE.items()))
        if expiry > current:
            break
        REPLAY_CACHE.pop(key, None)


class Transfer(BaseModel):
    transfer_id: str = Field(min_length=8)
    debit_account_id: str = Field(min_length=1)
    credit_account_id: str = Field(min_length=1)
    amount_minor: int = Field(gt=0)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
    correlation_id: str = Field(min_length=8)


class ScreenRequest(BaseModel):
    subject_id: str = Field(min_length=1)
    email: str | None = None
    full_name: str | None = None
    country: str | None = None


class EdgeRequest(BaseModel):
    subject: str = Field(min_length=1)
    route: str = Field(min_length=1)
    scopes: list[str] = []


@app.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok", "mode": "simulated_external_dependency"}


@app.get("/.well-known/openid-configuration")
def oidc_discovery(request: Request) -> dict[str, Any]:
    issuer = str(request.base_url).rstrip("/")
    return {
        "issuer": issuer,
        "authorization_endpoint": f"{issuer}/oidc/authorize",
        "token_endpoint": f"{issuer}/oidc/token",
        "jwks_uri": f"{issuer}/jwks.json",
        "response_types_supported": ["code"],
        "id_token_signing_alg_values_supported": ["RS256"],
    }


@app.get("/jwks.json")
def jwks() -> dict[str, list[Any]]:
    return {"keys": []}


@app.post("/v1/edge/authorize")
def authorize_edge(payload: EdgeRequest) -> dict[str, Any]:
    if payload.subject.startswith("revoked:"):
        raise HTTPException(status_code=403, detail="subject_revoked")
    if payload.route.startswith("/admin") and "admin" not in payload.scopes:
        raise HTTPException(status_code=403, detail="scope_required")
    return {"allowed": True, "subject": payload.subject, "route": payload.route}


@app.post("/v1/aml/screen")
def screen_aml(payload: ScreenRequest) -> dict[str, Any]:
    normalized_email = (payload.email or "").strip().lower()
    hit = normalized_email in AML_BLOCKED
    return {
        "screening_id": hashlib.sha256(payload.subject_id.encode()).hexdigest()[:24],
        "decision": "hit" if hit else "clear",
        "provider": "simulated-aml-provider",
        "list_version": "simulated-2026-01",
        "review_required": hit,
        "screened_at": now().isoformat(),
    }


@app.post("/v1/ledger/transfers")
def create_transfer(payload: Transfer, request: Request) -> dict[str, Any]:
    if payload.debit_account_id == payload.credit_account_id:
        raise HTTPException(status_code=422, detail="self_transfer_forbidden")
    existing = LEDGER.get(payload.transfer_id)
    if existing:
        if existing["request"] != payload.model_dump():
            raise HTTPException(status_code=409, detail="idempotency_payload_mismatch")
        return {"status": "duplicate", "transfer": existing["transfer"]}
    transfer = {
        "transfer_id": payload.transfer_id,
        "status": "posted",
        "amount_minor": payload.amount_minor,
        "currency": payload.currency,
        "correlation_id": payload.correlation_id,
        "posted_at": now().isoformat(),
    }
    LEDGER[payload.transfer_id] = {"request": payload.model_dump(), "transfer": transfer}
    return {"status": "accepted", "transfer": transfer}


@app.post("/v1/webhooks/provider")
async def provider_webhook(
    request: Request,
    x_provider_timestamp: str | None = Header(default=None),
    x_provider_signature: str | None = Header(default=None),
    x_provider_event_id: str | None = Header(default=None),
) -> dict[str, str]:
    if not x_provider_timestamp or not x_provider_signature or not x_provider_event_id:
        raise HTTPException(status_code=401, detail="webhook_headers_required")
    try:
        timestamp = int(x_provider_timestamp)
    except ValueError as exc:
        raise HTTPException(status_code=401, detail="invalid_timestamp") from exc
    current = int(time.time())
    if abs(current - timestamp) > REPLAY_WINDOW_SECONDS:
        raise HTTPException(status_code=401, detail="stale_webhook")
    cleanup_replay_cache(float(current))
    if x_provider_event_id in REPLAY_CACHE:
        raise HTTPException(status_code=409, detail="replayed_webhook")
    body = await request.body()
    signed = f"{x_provider_timestamp}.".encode() + body
    expected = hmac.new(WEBHOOK_SECRET, signed, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(x_provider_signature, expected):
        raise HTTPException(status_code=401, detail="invalid_signature")
    REPLAY_CACHE[x_provider_event_id] = current + REPLAY_WINDOW_SECONDS
    return {"status": "accepted", "event_id": x_provider_event_id}


@app.get("/v1/ledger/transfers/{transfer_id}")
def get_transfer(transfer_id: str) -> dict[str, Any]:
    existing = LEDGER.get(transfer_id)
    if not existing:
        raise HTTPException(status_code=404, detail="transfer_not_found")
    return existing["transfer"]


WORKFLOWS: dict[str, dict[str, Any]] = {}
EVENTS: dict[str, dict[str, Any]] = {}
LAKEHOUSE: list[dict[str, Any]] = []
INCIDENTS: dict[str, dict[str, Any]] = {}


class WorkflowRequest(BaseModel):
    workflow_id: str = Field(min_length=8)
    order_id: str = Field(min_length=1)
    correlation_id: str = Field(min_length=8)


class EventRequest(BaseModel):
    event_id: str = Field(min_length=8)
    event_type: str = Field(min_length=3)
    schema_version: str = Field(pattern=r"^v[0-9]+$")
    correlation_id: str = Field(min_length=8)
    payload: dict[str, Any]


class LakehouseEvent(BaseModel):
    event_id: str = Field(min_length=8)
    occurred_at: datetime
    source: str = Field(min_length=2)
    payload: dict[str, Any]


class EntityRecord(BaseModel):
    record_id: str = Field(min_length=1)
    full_name: str | None = None
    email: str | None = None
    phone: str | None = None


class EntityResolutionRequest(BaseModel):
    records: list[EntityRecord] = Field(min_length=2, max_length=1000)
    match_threshold: float = Field(default=0.90, ge=0.0, le=1.0)


@app.post("/v1/workflows/start")
def start_workflow(payload: WorkflowRequest) -> dict[str, Any]:
    existing = WORKFLOWS.get(payload.workflow_id)
    if existing:
        if existing["request"] != payload.model_dump():
            raise HTTPException(status_code=409, detail="workflow_id_payload_mismatch")
        return existing["workflow"]
    workflow = {
        "workflow_id": payload.workflow_id,
        "order_id": payload.order_id,
        "correlation_id": payload.correlation_id,
        "status": "started",
        "started_at": now().isoformat(),
    }
    WORKFLOWS[payload.workflow_id] = {"request": payload.model_dump(), "workflow": workflow}
    return workflow


@app.post("/v1/events/publish")
def publish_event(payload: EventRequest) -> dict[str, Any]:
    existing = EVENTS.get(payload.event_id)
    if existing:
        if existing["request"] != payload.model_dump():
            raise HTTPException(status_code=409, detail="event_id_payload_mismatch")
        return {"status": "duplicate", "event": existing["event"]}
    event = {**payload.model_dump(), "published_at": now().isoformat()}
    EVENTS[payload.event_id] = {"request": payload.model_dump(), "event": event}
    return {"status": "published", "event": event}


@app.post("/v1/wazuh/incidents")
def ingest_wazuh_incident(payload: dict[str, Any]) -> dict[str, Any]:
    rule_id = str(payload.get("rule_id", ""))
    if rule_id not in {"100810", "100811", "100820"}:
        raise HTTPException(status_code=422, detail="rule_not_allowlisted")
    incident_id = str(payload.get("dedup_key") or hashlib.sha256(repr(sorted(payload.items())).encode()).hexdigest())
    if incident_id in INCIDENTS:
        return {"status": "duplicate", "incident_id": incident_id}
    INCIDENTS[incident_id] = {"payload": payload, "received_at": now().isoformat()}
    return {"status": "accepted", "incident_id": incident_id}


@app.post("/v1/worm/attest")
def attest_worm(payload: dict[str, Any]) -> dict[str, Any]:
    required = {"object_version_id", "sha256", "signature_valid", "retention_mode", "retain_until"}
    if not required.issubset(payload):
        raise HTTPException(status_code=422, detail="worm_attestation_fields_required")
    if payload["retention_mode"] != "COMPLIANCE" or payload["signature_valid"] is not True:
        raise HTTPException(status_code=422, detail="worm_attestation_not_compliant")
    return {"status": "accepted", "attestation_id": hashlib.sha256(repr(sorted(payload.items())).encode()).hexdigest()}


@app.post("/v1/lakehouse/bronze")
def write_bronze(payload: LakehouseEvent) -> dict[str, Any]:
    forbidden = {"password", "secret", "token", "private_key", "raw_location"}
    if forbidden.intersection(payload.payload):
        raise HTTPException(status_code=422, detail="redaction_policy_violation")
    row = {**payload.model_dump(), "written_at": now().isoformat()}
    LAKEHOUSE.append(row)
    return {"status": "written", "event_id": payload.event_id}


def _similarity(left: EntityRecord, right: EntityRecord) -> float:
    scores: list[float] = []
    for field in ("full_name", "email", "phone"):
        a = (getattr(left, field) or "").strip().casefold()
        b = (getattr(right, field) or "").strip().casefold()
        if a and b:
            scores.append(1.0 if a == b else 0.0)
    return sum(scores) / len(scores) if scores else 0.0


@app.post("/v1/entity-resolution/resolve")
def resolve_entities(payload: EntityResolutionRequest) -> dict[str, Any]:
    parent: dict[str, str] = {record.record_id: record.record_id for record in payload.records}

    def find(value: str) -> str:
        while parent[value] != value:
            parent[value] = parent[parent[value]]
            value = parent[value]
        return value

    def union(left: str, right: str) -> None:
        left_root, right_root = find(left), find(right)
        if left_root != right_root:
            parent[right_root] = left_root

    matches = []
    for index, left in enumerate(payload.records):
        for right in payload.records[index + 1 :]:
            score = _similarity(left, right)
            if score >= payload.match_threshold:
                union(left.record_id, right.record_id)
                matches.append({"left": left.record_id, "right": right.record_id, "score": score})
    clusters: dict[str, list[str]] = {}
    for record in payload.records:
        clusters.setdefault(find(record.record_id), []).append(record.record_id)
    return {"status": "resolved", "matches": matches, "clusters": list(clusters.values())}
