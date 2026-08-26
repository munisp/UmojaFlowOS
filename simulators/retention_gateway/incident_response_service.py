from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Header, HTTPException, Request
from pydantic import BaseModel, Field


class AlertmanagerAlert(BaseModel):
    alertname: str
    status: str = "firing"
    labels: dict[str, str] = Field(default_factory=dict)
    annotations: dict[str, str] = Field(default_factory=dict)
    startsAt: str | None = None
    endsAt: str | None = None
    fingerprint: str | None = None


class AlertmanagerPayload(BaseModel):
    status: str = "firing"
    alerts: list[AlertmanagerAlert] = Field(default_factory=list)
    commonLabels: dict[str, str] = Field(default_factory=dict)
    commonAnnotations: dict[str, str] = Field(default_factory=dict)
    groupKey: str | None = None


SAFE_INCIDENT_ID = re.compile(r"^(?=.{1,128}$)[A-Za-z0-9][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*$")


def incident_evidence_directory(evidence_root: Path, fingerprint: str | None, body: bytes) -> tuple[str, Path]:
    """Return a canonical incident ID and a path proven to remain under root."""
    candidate = (fingerprint or "").strip()
    incident_id = candidate if SAFE_INCIDENT_ID.fullmatch(candidate) else hashlib.sha256(body).hexdigest()
    root = evidence_root.resolve()
    evidence = (root / incident_id).resolve()
    try:
        evidence.relative_to(root)
    except ValueError as exc:
        raise RuntimeError("incident evidence path escaped configured root") from exc
    return incident_id, evidence


class HMACWebhookVerifier:
    def __init__(self, secret: bytes, max_age_seconds: int = 300):
        if len(secret) < 32:
            raise ValueError("incident webhook secret must be at least 32 bytes")
        self.secret = secret
        self.max_age = timedelta(seconds=max_age_seconds)

    def verify(self, body: bytes, timestamp: str, signature: str, now: datetime | None = None) -> None:
        try:
            sent_at = datetime.fromtimestamp(int(timestamp), tz=timezone.utc)
            supplied = bytes.fromhex(signature.removeprefix("sha256="))
        except (TypeError, ValueError):
            raise HTTPException(status_code=401, detail="invalid webhook signature")
        current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
        if abs(current - sent_at) > self.max_age:
            raise HTTPException(status_code=401, detail="stale webhook timestamp")
        expected = hmac.new(self.secret, timestamp.encode() + b"." + body, hashlib.sha256).digest()
        if not hmac.compare_digest(supplied, expected):
            raise HTTPException(status_code=401, detail="invalid webhook signature")


class IncidentStore:
    def __init__(self, connect):
        self.connect = connect

    def initialize(self) -> None:
        with self.connect() as conn:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS retention_incident_events (
                  incident_id text PRIMARY KEY,
                  alert_name text NOT NULL,
                  status text NOT NULL,
                  payload_digest text NOT NULL,
                  received_at timestamptz NOT NULL,
                  evidence_path text NOT NULL,
                  containment_status text NOT NULL DEFAULT 'not_started'
                )
                """
            )

    def register(self, incident_id: str, alert_name: str, status: str, digest: str, evidence_path: str) -> bool:
        with self.connect() as conn:
            row = conn.execute(
                """
                INSERT INTO retention_incident_events
                  (incident_id, alert_name, status, payload_digest, received_at, evidence_path)
                VALUES (%s, %s, %s, %s, now(), %s)
                ON CONFLICT (incident_id) DO NOTHING
                RETURNING incident_id
                """,
                (incident_id, alert_name, status, digest, evidence_path),
            ).fetchone()
            return row is not None

    def mark_containment(self, incident_id: str, status: str) -> None:
        with self.connect() as conn:
            conn.execute(
                "UPDATE retention_incident_events SET containment_status=%s WHERE incident_id=%s",
                (status, incident_id),
            )


def safe_run(args: list[str], output: Path, timeout: int = 30) -> dict[str, Any]:
    allowed = {
        ("kubectl", "-n", "security", "get", "pods"),
        ("kubectl", "-n", "security", "get", "deployment", "umoja-retention-worker"),
        ("kubectl", "-n", "security", "rollout", "history", "deployment/umoja-retention-worker"),
    }
    if tuple(args) not in allowed:
        raise ValueError("command is not allow-listed")
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout, check=False)
    output.write_text(result.stdout + result.stderr)
    return {"command": args, "returncode": result.returncode}


def create_app() -> FastAPI:
    import psycopg

    app = FastAPI(title="Umoja retention incident response")
    secret = Path(os.environ["INCIDENT_WEBHOOK_SECRET_FILE"]).read_bytes().strip()
    evidence_root = Path(os.environ.get("INCIDENT_EVIDENCE_ROOT", "/var/lib/umoja/incidents"))
    verifier = HMACWebhookVerifier(secret)
    store = IncidentStore(lambda: psycopg.connect(os.environ["DATABASE_URL"]))
    store.initialize()

    @app.get("/healthz")
    def healthz():
        return {"status": "ok"}

    @app.post("/v1/alerts")
    async def alerts(
        request: Request,
        x_umoja_timestamp: str | None = Header(default=None),
        x_umoja_signature: str | None = Header(default=None),
    ):
        body = await request.body()
        if not x_umoja_timestamp or not x_umoja_signature:
            raise HTTPException(status_code=401, detail="missing webhook authentication")
        verifier.verify(body, x_umoja_timestamp, x_umoja_signature)
        try:
            payload = AlertmanagerPayload.model_validate_json(body)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail="invalid Alertmanager payload") from exc

        matching = [a for a in payload.alerts if a.alertname == "UmojaRetentionWorkerSecurityFailureBurst"]
        if not matching:
            return {"status": "ignored", "reason": "alert_not_in_scope"}
        alert = matching[0]
        service = alert.labels.get("service", payload.commonLabels.get("service"))
        if service != "retention-delete-worker":
            return {"status": "ignored", "reason": "service_not_in_scope"}

        incident_id, evidence = incident_evidence_directory(evidence_root, alert.fingerprint, body)
        evidence.mkdir(parents=True, exist_ok=True)
        (evidence / "alertmanager-payload.json").write_bytes(body)
        digest = hashlib.sha256(body).hexdigest()
        first = store.register(incident_id, alert.alertname, payload.status, digest, str(evidence))
        if not first:
            return {"status": "duplicate", "incident_id": incident_id}

        commands = [
            ["kubectl", "-n", "security", "get", "pods"],
            ["kubectl", "-n", "security", "get", "deployment", "umoja-retention-worker"],
            ["kubectl", "-n", "security", "rollout", "history", "deployment/umoja-retention-worker"],
        ]
        results = []
        for index, command in enumerate(commands):
            results.append(safe_run(command, evidence / f"command-{index}.txt"))
        (evidence / "capture-result.json").write_text(json.dumps(results, indent=2))
        store.mark_containment(incident_id, "evidence_captured_manual_containment_required")
        return {"status": "accepted", "incident_id": incident_id, "evidence_path": str(evidence)}

    return app


app = create_app() if os.getenv("INCIDENT_RESPONSE_IMPORT_ONLY") != "1" else FastAPI()
