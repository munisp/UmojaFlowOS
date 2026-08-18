from __future__ import annotations

from dataclasses import dataclass
from hashlib import sha256
import json
from typing import Mapping, Sequence


class LakehouseContractError(ValueError):
    pass


@dataclass(frozen=True)
class BatchManifest:
    dataset: str
    layer: str
    schema_version: str
    record_count: int
    payload_sha256: str


def build_bronze_manifest(dataset: str, records: Sequence[Mapping[str, object]], schema_version: str = "v1") -> BatchManifest:
    if not dataset.strip() or not schema_version.strip():
        raise LakehouseContractError("dataset and schema version are required")
    if not all(isinstance(record, Mapping) for record in records):
        raise LakehouseContractError("records must be mapping objects")
    canonical = json.dumps(list(records), sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return BatchManifest(dataset=dataset, layer="bronze", schema_version=schema_version, record_count=len(records), payload_sha256=sha256(canonical).hexdigest())
