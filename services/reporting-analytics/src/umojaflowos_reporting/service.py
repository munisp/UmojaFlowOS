from __future__ import annotations

import json
from typing import Any, Literal

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

from .reporting import ReportValidationError, build_evidence_manifest, validate_report_pack
from .lakehouse import LakehouseContractError, build_bronze_manifest


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


app = FastAPI(title="UmojaFlowOS Reporting Analytics", version="1.0.0")


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
