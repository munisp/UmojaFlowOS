from __future__ import annotations

import json
import threading
import time
from dataclasses import asdict
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any, Literal

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, Field

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
                "observed_at": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
                "regulatory_submission": "disabled_without_verified_channel",
            }


METRICS = ServiceMetrics()


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
