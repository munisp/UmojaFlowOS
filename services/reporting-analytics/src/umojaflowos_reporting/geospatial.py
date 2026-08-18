from __future__ import annotations

from dataclasses import dataclass
from typing import Mapping, Sequence


class GeospatialContractError(ValueError):
    pass


@dataclass(frozen=True)
class JurisdictionAggregation:
    jurisdiction: str
    cohort_count: int
    h3_resolution: int
    metric_name: str


def build_jurisdiction_aggregation(
    jurisdiction: str,
    cohort_count: int,
    h3_resolution: int,
    metric_name: str,
    source_rows: Sequence[Mapping[str, object]],
) -> JurisdictionAggregation:
    if jurisdiction not in {"NG", "KE", "ZA"}:
        raise GeospatialContractError("jurisdiction must be NG, KE, or ZA")
    if not metric_name.strip():
        raise GeospatialContractError("metric name is required")
    if not 5 <= h3_resolution <= 9:
        raise GeospatialContractError("H3 resolution must be between 5 and 9")
    if cohort_count < 10:
        raise GeospatialContractError("cohort count must be at least 10")
    forbidden = {"latitude", "longitude", "geometry", "document_uri", "account_number", "customer_name"}
    for row in source_rows:
        if forbidden.intersection(row):
            raise GeospatialContractError("raw location or identifying data is not permitted in a geospatial aggregate")
    return JurisdictionAggregation(jurisdiction, cohort_count, h3_resolution, metric_name)
