from __future__ import annotations

import os
import threading
from datetime import datetime, timedelta, timezone
from pathlib import Path

import requests
from fastapi import FastAPI, Header, HTTPException, Response
from prometheus_client import Counter, Gauge, Histogram, generate_latest, CONTENT_TYPE_LATEST
from pydantic import BaseModel, Field

from .decision_engine import DeleteRequest
REQUESTS = Counter("umoja_retention_worker_requests_total", "Delete worker requests", ["operation"])
RESULTS = Counter("umoja_retention_worker_results_total", "Delete worker results", ["result"])
FAILURES = Counter("umoja_retention_worker_failures_total", "Delete worker failures", ["result"])
LATENCY = Histogram("umoja_retention_worker_execution_seconds", "Delete execution latency", ["result"])
HEALTH = Gauge("umoja_retention_worker_health", "Delete worker health status")
DB_POOL_AVAILABLE = Gauge("umoja_retention_worker_db_pool_available", "Available PostgreSQL pool connections")
DB_POOL_WAITING = Gauge("umoja_retention_worker_db_pool_waiting", "Requests queued for PostgreSQL pool connections")
DB_POOL_SIZE = Gauge("umoja_retention_worker_db_pool_size", "Configured PostgreSQL pool size")
DB_CIRCUIT_STATE = Gauge("umoja_retention_worker_db_circuit_state", "PostgreSQL pool circuit state: 0 closed, 1 open, 2 half-open")
DB_CIRCUIT_OPEN_TOTAL = Counter("umoja_retention_worker_db_circuit_open_total", "PostgreSQL pool circuit-open transitions")
DB_CIRCUIT_REJECTIONS_TOTAL = Counter("umoja_retention_worker_db_circuit_rejections_total", "Requests rejected while PostgreSQL pool circuit is open")

from .delete_worker import (
    DeleteWorker,
    HMACAuthorizationVerifier,
    IndexIdentity,
    PostgresAuthorizationUseStore,
    OpenSearchAuthenticationError,
    OpenSearchAuthorizationError,
)


class DatabasePoolCircuitBreaker:
    """Fail-closed circuit breaker for repeated PostgreSQL pool-acquisition timeouts."""

    def __init__(self, failure_threshold: int, reset_seconds: float) -> None:
        if failure_threshold < 1 or reset_seconds <= 0:
            raise ValueError("circuit breaker threshold and reset period must be positive")
        self.failure_threshold = failure_threshold
        self.reset_period = timedelta(seconds=reset_seconds)
        self._lock = threading.Lock()
        self._consecutive_failures = 0
        self._state = "closed"
        self._open_until: datetime | None = None

    @property
    def state_value(self) -> int:
        return {"closed": 0, "open": 1, "half_open": 2}[self._state]

    def allow(self, now: datetime) -> bool:
        now = now.astimezone(timezone.utc)
        with self._lock:
            if self._state == "closed":
                return True
            if self._state == "open" and self._open_until is not None and now >= self._open_until:
                self._state = "half_open"
                return True
            return False

    def record_pool_saturation(self, now: datetime) -> None:
        now = now.astimezone(timezone.utc)
        with self._lock:
            self._consecutive_failures += 1
            if self._state != "open" and (self._state == "half_open" or self._consecutive_failures >= self.failure_threshold):
                self._state = "open"
                self._open_until = now + self.reset_period
                DB_CIRCUIT_OPEN_TOTAL.inc()

    def record_success(self) -> None:
        with self._lock:
            self._consecutive_failures = 0
            self._state = "closed"
            self._open_until = None


class DeletePayload(BaseModel):
    index: str = Field(min_length=1)
    index_uuid: str = Field(min_length=1)
    index_version: str = Field(min_length=1)
    expected_digest: str = Field(min_length=64, max_length=64)
    requested_by: str = Field(min_length=1)
    correlation_id: str = Field(min_length=1)
    decision_digest: str = Field(min_length=64, max_length=64)
    authorization_token: str = Field(min_length=1)


class HTTPOpenSearchClient:
    def __init__(self, base_url: str, ca_file: str, client_cert_file: str, client_key_file: str, digest_lookup):
        if not base_url.startswith("https://"):
            raise RuntimeError("OPENSEARCH_URL must use HTTPS")
        for label, path in (("CA", ca_file), ("client certificate", client_cert_file), ("client key", client_key_file)):
            if not path or not Path(path).is_file():
                raise RuntimeError(f"OpenSearch {label} file is required: {path}")
        self.base_url = base_url.rstrip("/")
        self.ca_file = ca_file
        self.client_cert = (client_cert_file, client_key_file)
        self.digest_lookup = digest_lookup

    def _request(self, method: str, path: str, **kwargs):
        kwargs.setdefault("verify", self.ca_file)
        kwargs.setdefault("cert", self.client_cert)
        kwargs.setdefault("timeout", 10)
        try:
            response = requests.request(method, f"{self.base_url}/{path.lstrip('/')}", **kwargs)
        except (requests.exceptions.SSLError, requests.exceptions.ConnectionError) as exc:
            raise OpenSearchAuthenticationError(f"OpenSearch TLS/authentication failure: {exc}") from exc
        if response.status_code in (401, 407):
            raise OpenSearchAuthenticationError(f"OpenSearch returned HTTP {response.status_code}")
        if response.status_code == 403:
            raise OpenSearchAuthorizationError("OpenSearch returned HTTP 403")
        return response

    def identity(self, index: str) -> IndexIdentity | None:
        response = self._request(
            "GET", f"/{index}/_settings/index.uuid,index.version"
        )
        if response.status_code == 404:
            return None
        response.raise_for_status()
        settings = response.json()[index]["settings"]["index"]
        index_uuid = settings["uuid"]
        index_version = settings.get("version", "1")
        archive_digest = self.digest_lookup(index, index_uuid, index_version)
        if archive_digest is None:
            return None
        return IndexIdentity(index, index_uuid, index_version, archive_digest)

    def delete_exact_index(self, index: str, expected_uuid: str, expected_version: str) -> bool:
        if "*" in index or "," in index or "_all" in index:
            raise RuntimeError("wildcard or multi-index deletion is forbidden")
        response = self._request("DELETE", f"/{index}")
        if response.status_code == 404:
            return False
        response.raise_for_status()
        return True


def build_app() -> FastAPI:
    app = FastAPI(title="Umoja retention delete worker")
    expected_token = os.environ["RETENTION_WORKER_BEARER_TOKEN"]
    database_url = os.environ["DATABASE_URL"]
    hmac_secret = open(os.environ["RETENTION_GATEWAY_HMAC_SECRET_FILE"], "rb").read().strip()
    manifest_secret = open(os.environ["RETENTION_MANIFEST_HMAC_SECRET_FILE"], "rb").read().strip()
    from psycopg_pool import ConnectionPool
    statement_timeout_ms = int(os.getenv("RETENTION_DB_STATEMENT_TIMEOUT_MS", "5000"))
    lock_timeout_ms = int(os.getenv("RETENTION_DB_LOCK_TIMEOUT_MS", "1500"))
    idle_transaction_timeout_ms = int(os.getenv("RETENTION_DB_IDLE_TRANSACTION_TIMEOUT_MS", "10000"))
    if min(statement_timeout_ms, lock_timeout_ms, idle_transaction_timeout_ms) <= 0:
        raise RuntimeError("retention database timeouts must be positive")
    pool = ConnectionPool(
        conninfo=database_url,
        kwargs={
            "options": (
                f"-c statement_timeout={statement_timeout_ms} "
                f"-c lock_timeout={lock_timeout_ms} "
                f"-c idle_in_transaction_session_timeout={idle_transaction_timeout_ms}"
            )
        },
        min_size=int(os.getenv("RETENTION_DB_POOL_MIN_SIZE", "2")),
        max_size=int(os.getenv("RETENTION_DB_POOL_MAX_SIZE", "10")),
        timeout=float(os.getenv("RETENTION_DB_POOL_TIMEOUT_SECONDS", "2")),
        open=True,
    )
    store = PostgresAuthorizationUseStore(pool.connection, manifest_secret=manifest_secret)
    opensearch = HTTPOpenSearchClient(
        os.environ["OPENSEARCH_URL"],
        os.environ["OPENSEARCH_CA_FILE"],
        os.environ["OPENSEARCH_CLIENT_CERT_FILE"],
        os.environ["OPENSEARCH_CLIENT_KEY_FILE"],
        store.archive_digest,
    )
    store.initialize()
    worker = DeleteWorker(HMACAuthorizationVerifier(hmac_secret), store, opensearch)
    circuit = DatabasePoolCircuitBreaker(
        int(os.getenv("RETENTION_DB_CIRCUIT_FAILURE_THRESHOLD", "3")),
        float(os.getenv("RETENTION_DB_CIRCUIT_RESET_SECONDS", "30")),
    )

    @app.get("/healthz")
    def healthz():
        HEALTH.set(1)
        return {"status": "ok"}

    @app.get("/metrics")
    def metrics():
        stats = pool.get_stats()
        DB_POOL_AVAILABLE.set(stats.get("pool_available", 0))
        DB_POOL_WAITING.set(stats.get("requests_waiting", 0))
        DB_POOL_SIZE.set(stats.get("pool_size", 0))
        DB_CIRCUIT_STATE.set(circuit.state_value)
        return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)

    @app.post("/v1/worker/delete")
    def delete(payload: DeletePayload, authorization: str | None = Header(default=None)):
        REQUESTS.labels(operation="delete").inc()
        if authorization != f"Bearer {expected_token}":
            RESULTS.labels(result="unauthorized").inc()
            FAILURES.labels(result="unauthorized").inc()
            raise HTTPException(status_code=401, detail="unauthorized")
        request = DeleteRequest(
            payload.index,
            payload.index_uuid,
            payload.index_version,
            payload.expected_digest,
            payload.requested_by,
            payload.correlation_id,
        )
        started = datetime.now(timezone.utc)
        if not circuit.allow(started):
            result = "database_circuit_open"
            DB_CIRCUIT_REJECTIONS_TOTAL.inc()
        else:
            result = worker.execute(
                payload.authorization_token,
                request,
                payload.decision_digest,
                started,
            )
        if result == "database_connection_pool_saturated":
            circuit.record_pool_saturation(started)
        elif result not in {"database_circuit_open", "database_claim_error"}:
            circuit.record_success()
        elapsed = (datetime.now(timezone.utc) - started).total_seconds()
        RESULTS.labels(result=result).inc()
        LATENCY.labels(result=result).observe(elapsed)
        if result.startswith("denied") or result == "delete_execution_error":
            FAILURES.labels(result=result).inc()
            raise HTTPException(status_code=409, detail=result)
        if result in {"database_connection_pool_saturated", "database_claim_error", "database_circuit_open"}:
            FAILURES.labels(result=result).inc()
            raise HTTPException(status_code=503, detail=result)
        return {"status": result, "correlation_id": payload.correlation_id}

    return app


app = build_app() if os.getenv("RETENTION_WORKER_IMPORT_ONLY") != "1" else FastAPI()

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8080)
