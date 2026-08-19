from __future__ import annotations

import json
import hashlib
import os
import threading
import time
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal, Protocol

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field
from redis import Redis
from redis.exceptions import RedisError

from .reporting import ReportValidationError, build_evidence_manifest, validate_report_pack
from .lakehouse import LakehouseContractError, build_bronze_manifest
from .geospatial import GeospatialContractError, build_jurisdiction_aggregation
from .assembly import ReportAssemblyError, assemble_regulatory_report, validate_assembled_report
from .stablecoin_exposure import (
    ExposureReportError,
    PegObservation,
    StablecoinPosition,
    build_stablecoin_exposure_report,
)
from .opensearch_adapter import OpenSearchConfig, OpenSearchProjectionWriter, OpenSearchUnavailable, redacted_search_document
from .lakehouse_writer import BronzeLakehouseWriter, LakehouseConfig, LakehouseUnavailable
from .lifecycle_event_lakehouse import LifecycleEventProjectionError, project_lifecycle_event
from .sedona_livy import SedonaAggregateJobClient, SedonaLivyConfig, SedonaUnavailable
from .geolibre_project import GeoLibrePublicationError, build_aggregate_project


class ReportPackRequest(BaseModel):
    regulator: Literal["CBN", "CBK", "SARB"]
    corridor: Literal["Nigeria", "Kenya", "South Africa"]
    report_type: str = Field(min_length=4, max_length=255)
    period_start: str
    period_end: str
    regulated_entity_id: str = Field(min_length=1, max_length=255)
    transactions: list[dict[str, Any]]


class LakehouseBatchRequest(BaseModel):
    dataset: str = Field(min_length=1, max_length=255)
    schema_version: str = Field(default="v1", min_length=1, max_length=64)
    records: list[dict[str, Any]]


class GeospatialAggregationRequest(BaseModel):
    jurisdiction: Literal["NG", "KE", "ZA"]
    cohort_count: int = Field(ge=0)
    h3_resolution: int = Field(ge=0, le=15)
    metric_name: str = Field(min_length=1, max_length=255)
    source_rows: list[dict[str, Any]]


class SearchProjectionRequest(BaseModel):
    projection: dict[str, Any]


class SedonaAggregateSubmissionRequest(BaseModel):
    input_uri: str = Field(min_length=8, max_length=2048)
    output_uri: str = Field(min_length=8, max_length=2048)
    metric_name: str = Field(min_length=1, max_length=255)
    h3_resolution: int = Field(ge=5, le=9)


class GeoLibreProjectRequest(BaseModel):
    project_name: str = Field(min_length=1, max_length=120)
    aggregate_object_key: str = Field(min_length=1, max_length=1024)


class ReportAssemblyRequest(BaseModel):
    regulator: Literal["CBN", "CBK", "SARB"]
    report_type: str = Field(min_length=4, max_length=255)
    period_start: str
    period_end: str
    regulated_entity_id: str = Field(min_length=1, max_length=255)
    transactions: list[dict[str, Any]]


class StablecoinPositionRequest(BaseModel):
    corridor: Literal["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]
    asset: Literal["USDC", "USDT"]
    account_reference: str = Field(min_length=1, max_length=255)
    available_amount: str
    reserved_amount: str
    source_reference: str = Field(min_length=1, max_length=255)
    reconciled_at: datetime


class PegObservationRequest(BaseModel):
    asset: Literal["USDC", "USDT"]
    rate_to_usd: str
    source_reference: str = Field(min_length=1, max_length=255)
    observed_at: datetime


class StablecoinExposureRequest(BaseModel):
    as_of: datetime
    max_position_age_minutes: int = Field(gt=0, le=10_080)
    max_observation_age_minutes: int = Field(gt=0, le=1_440)
    positions: list[StablecoinPositionRequest]
    peg_observations: list[PegObservationRequest]


PAYMENT_ORDER_VALIDATED_EVENT = "umojaflowos.payment.order.validated.v1"
POLICY_DECISION_EVENT = "umojaflowos.policy.decision.v1"


class DaprCloudEvent(BaseModel):
    """The documented CloudEvents envelope Dapr delivers to a subscriber.

    The `data` member remains deliberately narrow and opaque at this boundary:
    it is evidence from another service, not an instruction to execute a
    payment or submit a report. The event identity, type, version and
    correlation ID are checked before it reaches a durable ledger.
    """

    id: str = Field(min_length=1, max_length=255)
    source: str = Field(min_length=1, max_length=255)
    specversion: Literal["1.0"]
    type: str = Field(min_length=1, max_length=255)
    topic: str = Field(min_length=1, max_length=255)
    pubsubname: str = Field(min_length=1, max_length=255)
    data: dict[str, Any]


class EventEvidenceLedger(Protocol):
    """Durably records a validated stream event before the subscriber ACKs it."""

    def record(self, event: DaprCloudEvent) -> bool:
        """Persist an event idempotently or raise when the durable store is unavailable."""


class UnavailableEventEvidenceLedger:
    """Safe default until a configured durable event ledger is attached.

    Returning success here would tell Kafka that an event had been processed
    even though it had nowhere durable to go. Raising makes FastAPI return 503,
    and Dapr will retry rather than discard it. Redis becomes the configured
    ledger in the platform-tier integration; this object is deliberately not an
    in-memory stand-in.
    """

    def record(self, event: DaprCloudEvent) -> bool:
        raise RuntimeError("event evidence ledger is unavailable")


class RedisEventEvidenceLedger:
    """Redis-backed idempotency and append-only evidence stream.

    Redis is deliberately *not* the payment or accounting record — PostgreSQL
    remains canonical and TigerBeetle remains the activation-gated double-entry
    system. This ledger solves a narrower stream-processing problem: Dapr/Kafka
    delivery is at-least-once, so a consumer needs a durable atomic marker before
    it ACKs an event. The Lua transaction sets a hashed event-id marker and
    appends the exact validated CloudEvent to the operational evidence stream in
    one server-side operation. If Redis cannot do both, the route returns 503
    and Dapr retries rather than claiming delivery.

    The stream is immutable from the application's perspective. No `XDEL`,
    `XTRIM`, `SET`, `DEL`, or expiry operation is exposed; production retention
    is an operator policy on Redis, not code deciding what evidence may vanish.
    """

    _STREAM_KEY = "umojaflowos:event-evidence:v1"
    _DEDUPE_PREFIX = "umojaflowos:event-evidence:seen:v1:"
    _DEDUPE_TTL_SECONDS = 60 * 60 * 24 * 7
    _RECORD_SCRIPT = """
local added = redis.call('SET', KEYS[1], '1', 'NX', 'EX', ARGV[1])
if added then
  redis.call('XADD', KEYS[2], '*', 'cloud_event', ARGV[2], 'event_id', ARGV[3], 'event_type', ARGV[4])
  return 1
end
return 0
"""

    def __init__(self, redis_url: str) -> None:
        if not redis_url.strip():
            raise ValueError("Redis URL is required for the event evidence ledger")
        self._redis = Redis.from_url(redis_url, decode_responses=True, socket_timeout=5, socket_connect_timeout=5)
        self._record_script = self._redis.register_script(self._RECORD_SCRIPT)

    def verify_connection(self) -> None:
        """Prove the configured endpoint is a reachable Redis before activation."""
        try:
            if not self._redis.ping():
                raise RuntimeError("Redis did not acknowledge PING")
        except RedisError as exc:
            raise RuntimeError("event evidence ledger is unavailable") from exc

    @staticmethod
    def _dedupe_key(event_id: str) -> str:
        # Event IDs came from another service. Hashing keeps their untrusted
        # bytes out of Redis keyspace while retaining collision resistance.
        digest = hashlib.sha256(event_id.encode("utf-8")).hexdigest()
        return f"{RedisEventEvidenceLedger._DEDUPE_PREFIX}{digest}"

    def record(self, event: DaprCloudEvent) -> bool:
        serialized = json.dumps(event.model_dump(), sort_keys=True, separators=(",", ":"))
        if len(serialized.encode("utf-8")) > 256 * 1024:
            raise RuntimeError("event evidence exceeds the 256 KiB operational stream limit")
        data = event.data
        try:
            inserted = self._record_script(
                keys=[self._dedupe_key(str(data["event_id"])), self._STREAM_KEY],
                args=[self._DEDUPE_TTL_SECONDS, serialized, data["event_id"], data["event_type"]],
            )
            return bool(inserted)
        except RedisError as exc:
            raise RuntimeError("event evidence ledger is unavailable") from exc


def configure_event_evidence_ledger(redis_url: str) -> None:
    """Activate the stream consumer only after a real Redis PING succeeds."""

    global EVENT_EVIDENCE_LEDGER
    ledger = RedisEventEvidenceLedger(redis_url)
    ledger.verify_connection()
    EVENT_EVIDENCE_LEDGER = ledger


app = FastAPI(title="UmojaFlowOS Reporting Analytics", version="1.0.0")

# Envelope identity published in docs/service-contracts.md and pinned by the
# TypeScript control plane with strict literals. Changing any of these strings is
# a breaking contract change and requires a new v2 envelope type, not an edit.
SERVICE_NAME = "umojaflowos-reporting-analytics"
CONTRACT_VERSION = "v1"
ASSEMBLED_REPORT_ENVELOPE = "umojaflowos.reporting.assembled_report.v1"
STABLECOIN_EXPOSURE_ENVELOPE = "umojaflowos.reporting.stablecoin_exposure.v1"

# The assembler names corridors in prose ("Nigeria"); the cross-language contract
# uses the platform's canonical corridor identifiers. Mapping here keeps the
# assembler's own output unchanged while making the wire form unambiguous.
CONTRACT_CORRIDOR_BY_REGULATOR = {
    "CBN": "NIGERIA_NGN",
    "CBK": "KENYA_KES",
    "SARB": "SOUTH_AFRICA_ZAR",
}


class ServiceMetrics:
    """Counters observed while the service runs.

    These are collected in middleware rather than inside each endpoint. Counting
    per-endpoint would mean every new route has to remember to increment, and
    the one that forgets is invisible: the dashboard would simply under-report
    with no signal that it was doing so. Middleware makes the measurement a
    property of the server rather than a convention.

    Nothing here is derived or estimated. A quantity the service cannot observe
    is absent from the payload rather than reported as zero, because a
    fabricated zero reads as "nothing happening" and is worse than a gap.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._started_at = time.monotonic()
        self.requests_total = 0
        self.requests_rejected = 0  # 4xx: the caller's input was refused
        self.requests_failed = 0  # 5xx: the service itself failed
        self.reports_assembled = 0
        self.exposure_reports = 0
        self.lakehouse_batches = 0
        self.sedona_jobs_submitted = 0

    def record_request(self, status_code: int) -> None:
        with self._lock:
            self.requests_total += 1
            if 400 <= status_code < 500:
                self.requests_rejected += 1
            elif status_code >= 500:
                self.requests_failed += 1

    def record_assembly(self) -> None:
        with self._lock:
            self.reports_assembled += 1

    def record_exposure(self) -> None:
        with self._lock:
            self.exposure_reports += 1

    def record_lakehouse_batch(self) -> None:
        with self._lock:
            self.lakehouse_batches += 1

    def record_sedona_job(self) -> None:
        with self._lock:
            self.sedona_jobs_submitted += 1

    def snapshot(self) -> dict[str, Any]:
        with self._lock:
            return {
                "service": "reporting-analytics",
                "language": "python",
                "uptime_seconds": int(time.monotonic() - self._started_at),
                "requests_total": self.requests_total,
                "requests_rejected": self.requests_rejected,
                "requests_failed": self.requests_failed,
                "reports_assembled": self.reports_assembled,
                "exposure_reports": self.exposure_reports,
                "lakehouse_batches": self.lakehouse_batches,
                "sedona_jobs_submitted": self.sedona_jobs_submitted,
                "observed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                "regulatory_submission": "disabled_without_verified_channel",
            }


METRICS = ServiceMetrics()
EVENT_EVIDENCE_LEDGER: EventEvidenceLedger = UnavailableEventEvidenceLedger()


@app.on_event("startup")
def configure_event_evidence_ledger_from_environment() -> None:
    """Opt in only when deployment supplies an explicit Redis URL.

    There is intentionally no localhost default. An unconfigured deployment
    continues to return 503 to Dapr, making event handling visibly blocked
    rather than quietly starting against an accidental Redis instance.
    """

    redis_url = os.environ.get("UMOJA_REDIS_URL")
    if not redis_url:
        return
    configure_event_evidence_ledger(redis_url)


@app.middleware("http")
async def count_requests(request: Request, call_next):  # type: ignore[no-untyped-def]
    """Counts every served request, including those that raise."""
    try:
        response = await call_next(request)
    except Exception:
        # An unhandled exception is a served request that failed; not counting
        # it would make the failure invisible in exactly the case that matters.
        METRICS.record_request(500)
        raise
    # The metrics read itself is excluded, otherwise polling the dashboard would
    # inflate the very numbers it displays.
    if request.url.path != "/v1/metrics":
        METRICS.record_request(response.status_code)
    return response


@app.get("/v1/metrics")
def metrics() -> dict[str, Any]:
    return METRICS.snapshot()


@app.get("/healthz")
def health() -> dict[str, str]:
    return {"service": "reporting-analytics", "status": "healthy", "regulatory_submission": "disabled_without_verified_channel"}


@app.post("/events/payment-order-validated")
def receive_payment_or_policy_event(event: DaprCloudEvent) -> dict[str, str]:
    """Validate and durably record a Dapr-delivered event before acknowledging it.

    Dapr invokes this route for the Kafka `payment.events` subscription. An
    HTTP success is an acknowledgement to the broker, so the route refuses to
    return one until a durable evidence ledger has accepted the event. In the
    absence of configured Redis that produces a 503 and Dapr retries; silently
    accepting then dropping an event would be a data-loss bug.
    """

    if event.topic != "payment.events" or event.pubsubname != "kafka":
        raise HTTPException(status_code=422, detail="event arrived through an unrecognised stream")
    if event.type not in {"com.dapr.event.sent", PAYMENT_ORDER_VALIDATED_EVENT, POLICY_DECISION_EVENT}:
        raise HTTPException(status_code=422, detail="event type is not accepted by this subscriber")

    data = event.data
    required = {"event_id", "event_type", "schema_version", "correlation_id", "payload"}
    if not required.issubset(data):
        raise HTTPException(status_code=422, detail="event evidence is incomplete")
    if data["event_type"] not in {PAYMENT_ORDER_VALIDATED_EVENT, POLICY_DECISION_EVENT}:
        raise HTTPException(status_code=422, detail="event evidence type is not recognised")
    if data["schema_version"] != "v1":
        raise HTTPException(status_code=422, detail="event evidence schema version is not supported")
    if not isinstance(data["event_id"], str) or not data["event_id"].strip():
        raise HTTPException(status_code=422, detail="event evidence id is invalid")
    if not isinstance(data["correlation_id"], str) or not data["correlation_id"].strip():
        raise HTTPException(status_code=422, detail="event evidence correlation id is invalid")
    if not isinstance(data["payload"], dict):
        raise HTTPException(status_code=422, detail="event evidence payload must be an object")

    try:
        inserted = EVENT_EVIDENCE_LEDGER.record(event)
    except RuntimeError as exc:
        # A 503 deliberately tells Dapr/Kafka not to ACK. It is not a user
        # input refusal; it is a durable-processing outage that must retry.
        raise HTTPException(status_code=503, detail=str(exc)) from exc

    # A governed deployment can require the redacted immutable analytics
    # projection before Dapr receives an ACK.  Without this explicit flag the
    # event remains durable in Redis evidence only; there is intentionally no
    # implicit object-store endpoint or credential fallback.
    response = {"status": "SUCCESS", "delivery": "recorded" if inserted else "duplicate"}
    if os.environ.get("UMOJA_LAKEHOUSE_PROJECT_EVENTS") == "true":
        try:
            _key, lakehouse_status = project_lifecycle_event(configured_lakehouse_writer(), event.model_dump())
            METRICS.record_lakehouse_batch()
        except (LakehouseUnavailable, LifecycleEventProjectionError, LakehouseContractError) as exc:
            raise HTTPException(status_code=503, detail=f"lifecycle analytics projection is unavailable: {exc}") from exc
        response["lakehouse_projection"] = lakehouse_status
    # Dapr treats both results as an ACK. `duplicate` means a prior delivery
    # was already durably appended; it does not create a second evidence row.
    return response


@app.post("/v1/reports/validate")
def validate_report(request: ReportPackRequest) -> dict[str, Any]:
    pack = request.model_dump()
    try:
        validate_report_pack(pack)
        canonical_payload = json.dumps(pack, sort_keys=True, separators=(",", ":")).encode("utf-8")
        manifest = build_evidence_manifest(request.regulator, canonical_payload, len(request.transactions))
        return {"valid": True, "manifest": manifest.__dict__, "regulatory_submission": "disabled_without_verified_channel"}
    except ReportValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/v1/lakehouse/bronze-manifest")
def lakehouse_bronze_manifest(request: LakehouseBatchRequest) -> dict[str, Any]:
    try:
        return {"manifest": build_bronze_manifest(request.dataset, request.records, request.schema_version).__dict__, "storage": "disabled_without_governed_lakehouse"}
    except LakehouseContractError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


def configured_lakehouse_writer() -> BronzeLakehouseWriter:
    endpoint_url = os.environ.get("UMOJA_LAKEHOUSE_ENDPOINT")
    bucket = os.environ.get("UMOJA_LAKEHOUSE_BUCKET")
    access_key_id = os.environ.get("UMOJA_LAKEHOUSE_ACCESS_KEY_ID")
    secret_access_key = os.environ.get("UMOJA_LAKEHOUSE_SECRET_ACCESS_KEY")
    if not endpoint_url or not bucket or not access_key_id or not secret_access_key:
        raise LakehouseUnavailable("lakehouse is unavailable until an approved endpoint, bucket, and deployment secrets are configured")
    return BronzeLakehouseWriter(
        LakehouseConfig(
            endpoint_url=endpoint_url,
            bucket=bucket,
            access_key_id=access_key_id,
            secret_access_key=secret_access_key,
            region_name=os.environ.get("UMOJA_LAKEHOUSE_REGION", "us-east-1"),
            allow_insecure_loopback=os.environ.get("UMOJA_LAKEHOUSE_ALLOW_INSECURE_LOOPBACK") == "true",
        )
    )


@app.post("/v1/lakehouse/bronze")
def write_lakehouse_bronze(request: LakehouseBatchRequest) -> dict[str, Any]:
    """Write an immutable, redacted bronze evidence batch to configured storage."""

    try:
        manifest, key, status = configured_lakehouse_writer().write(request.dataset, request.records, request.schema_version)
        METRICS.record_lakehouse_batch()
        return {"status": status, "object_key": key, "manifest": manifest.__dict__}
    except LakehouseContractError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except LakehouseUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/geospatial/jurisdiction-aggregation")
def geospatial_jurisdiction_aggregation(request: GeospatialAggregationRequest) -> dict[str, Any]:
    try:
        aggregation = build_jurisdiction_aggregation(
            request.jurisdiction,
            request.cohort_count,
            request.h3_resolution,
            request.metric_name,
            request.source_rows,
        )
        return {"aggregation": aggregation.__dict__, "sedona_execution": "disabled_without_approved_spark_sedona_cluster", "geolibre_projection": "disabled_without_approved_aggregate_map_deployment"}
    except GeospatialContractError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/v1/geospatial/sedona/submit")
def submit_sedona_aggregate(request: SedonaAggregateSubmissionRequest) -> dict[str, Any]:
    """Submit the aggregate-only Sedona job to a configured Livy cluster."""

    endpoint = os.environ.get("UMOJA_SEDONA_LIVY_URL")
    token = os.environ.get("UMOJA_SEDONA_LIVY_BEARER_TOKEN")
    artifact = os.environ.get("UMOJA_SEDONA_AGGREGATE_JOB_URI")
    if not endpoint or not token or not artifact:
        raise HTTPException(status_code=503, detail="geospatial aggregation is unavailable until an approved Sedona cluster, job artifact, and deployment secret are configured")
    try:
        client = SedonaAggregateJobClient(
            SedonaLivyConfig(
                base_url=endpoint,
                bearer_token=token,
                aggregate_job_uri=artifact,
                allow_insecure_loopback=os.environ.get("UMOJA_SEDONA_ALLOW_INSECURE_LOOPBACK") == "true",
            )
        )
        batch_id = client.submit(request.input_uri, request.output_uri, request.metric_name, request.h3_resolution)
        METRICS.record_sedona_job()
        return {"status": "submitted", "livy_batch_id": batch_id, "execution": "Apache Sedona aggregate-only job"}
    except SedonaUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/geospatial/geolibre-project")
def create_geolibre_project(request: GeoLibreProjectRequest) -> dict[str, Any]:
    """Create a GeoLibre v0.1.0 viewer project for a signed aggregate object."""

    if not request.aggregate_object_key.startswith("silver/geospatial-aggregates/"):
        raise HTTPException(status_code=422, detail="GeoLibre projects may reference only approved aggregate map outputs")
    viewer_url = os.environ.get("UMOJA_GEOLIBRE_VIEWER_URL")
    if not viewer_url:
        raise HTTPException(status_code=503, detail="aggregate map is unavailable until an approved GeoLibre viewer deployment is configured")
    try:
        data_url = configured_lakehouse_writer().presigned_read_url(request.aggregate_object_key)
        publication = build_aggregate_project(request.project_name, data_url, viewer_url)
        return {"project": publication.project, "viewer_url": publication.viewer_url, "data_policy": "aggregate_only"}
    except (LakehouseUnavailable, GeoLibrePublicationError) as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/search/project")
def project_search_document(request: SearchProjectionRequest) -> dict[str, str]:
    """Write a redacted audit/case search projection only when explicitly configured.

    The environment has no OpenSearch default. This keeps a missing search
    cluster visibly unavailable instead of silently succeeding against a
    machine-local endpoint. Inputs are reduced to the approved projection
    fields before any request is emitted.
    """

    endpoint = os.environ.get("UMOJA_OPENSEARCH_URL")
    token = os.environ.get("UMOJA_OPENSEARCH_BEARER_TOKEN")
    if not endpoint or not token:
        raise HTTPException(status_code=503, detail="search projection is unavailable until an approved endpoint and deployment secret are configured")
    try:
        index, document_id, document = redacted_search_document(request.projection)
        writer = OpenSearchProjectionWriter(
            OpenSearchConfig(
                base_url=endpoint,
                bearer_token=token,
                allow_insecure_loopback=os.environ.get("UMOJA_OPENSEARCH_ALLOW_INSECURE_LOOPBACK") == "true",
            )
        )
        outcome = writer.write(index, document_id, document)
        return {"status": outcome, "index": index, "document_id": document_id}
    except OpenSearchUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc


@app.post("/v1/reports/assemble")
def assemble_report(request: ReportAssemblyRequest) -> dict[str, Any]:
    """Assemble a regulator report artifact from canonical transaction records."""
    try:
        report = assemble_regulatory_report(
            regulator=request.regulator,
            report_type=request.report_type,
            period_start=request.period_start,
            period_end=request.period_end,
            regulated_entity_id=request.regulated_entity_id,
            transactions=request.transactions,
        )
        # Re-verify the artifact before returning it so a corrupt assembly can
        # never leave this endpoint.
        validate_assembled_report(report)
        # Counted after verification: an artifact that failed its own check was
        # not assembled in any sense an operator would recognise.
        METRICS.record_assembly()
        return {
            "service": SERVICE_NAME,
            "contract_version": CONTRACT_VERSION,
            "envelope_type": ASSEMBLED_REPORT_ENVELOPE,
            "regulator": report.regulator,
            "corridor": CONTRACT_CORRIDOR_BY_REGULATOR[report.regulator],
            "settlement_currency": report.settlement_currency,
            "report_type": report.report_type,
            "period_start": report.period_start,
            "period_end": report.period_end,
            "regulated_entity_id": report.regulated_entity_id,
            "generated_at": report.generated_at,
            "totals": asdict(report.totals),
            "artifact_digest": report.artifact_digest,
            # The assembler produces a draft artifact only. It cannot declare a
            # regulator submission: that state exists solely in the control plane
            # once an authorised channel returns a reference.
            "submission_state": "assembled_pending_review",
        }
    except (ReportAssemblyError, ReportValidationError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@app.post("/v1/treasury/stablecoin-exposure")
def stablecoin_exposure(request: StablecoinExposureRequest) -> dict[str, Any]:
    """Aggregate reconciled USDC and USDT positions into corridor exposure."""
    try:
        positions = [
            StablecoinPosition(
                corridor=item.corridor,
                asset=item.asset,
                account_reference=item.account_reference,
                available_amount=Decimal(item.available_amount),
                reserved_amount=Decimal(item.reserved_amount),
                source_reference=item.source_reference,
                reconciled_at=item.reconciled_at,
            )
            for item in request.positions
        ]
        observations = {
            item.asset: PegObservation(
                asset=item.asset,
                rate_to_usd=Decimal(item.rate_to_usd),
                source_reference=item.source_reference,
                observed_at=item.observed_at,
            )
            for item in request.peg_observations
        }
        report = build_stablecoin_exposure_report(
            positions,
            observations,
            as_of=request.as_of,
            max_position_age=timedelta(minutes=request.max_position_age_minutes),
            max_observation_age=timedelta(minutes=request.max_observation_age_minutes),
        )
        METRICS.record_exposure()
        return {
            "service": SERVICE_NAME,
            "contract_version": CONTRACT_VERSION,
            "envelope_type": STABLECOIN_EXPOSURE_ENVELOPE,
            "generated_at": report.generated_at.isoformat(),
            "total_usd_equivalent": str(report.total_usd_equivalent),
            "corridor_exposures": [
                {
                    key: (
                        str(value)
                        if isinstance(value, Decimal)
                        else list(value)
                        if isinstance(value, tuple)
                        else value
                    )
                    for key, value in asdict(exposure).items()
                }
                for exposure in report.corridor_exposures
            ],
            "observations": list(report.observations),
        }
    except ExposureReportError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
