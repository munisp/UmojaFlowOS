from __future__ import annotations

from dataclasses import dataclass

from .geospatial import JurisdictionAggregation


class GeoLibreProjectionError(ValueError):
    pass


@dataclass(frozen=True)
class GeoLibreLayer:
    layer_id: str
    source_kind: str
    jurisdiction: str
    h3_resolution: int
    metric_name: str
    cohort_count: int


def build_geolibre_layer(aggregate: JurisdictionAggregation) -> GeoLibreLayer:
    if aggregate.cohort_count < 10:
        raise GeoLibreProjectionError("GeoLibre projection requires a cohort of at least 10")
    if aggregate.jurisdiction not in {"NG", "KE", "ZA"}:
        raise GeoLibreProjectionError("unsupported jurisdiction")
    if not aggregate.metric_name.strip():
        raise GeoLibreProjectionError("metric name is required")
    return GeoLibreLayer(
        layer_id=f"umojaflowos-{aggregate.jurisdiction.lower()}-{aggregate.metric_name}",
        source_kind="h3_aggregate",
        jurisdiction=aggregate.jurisdiction,
        h3_resolution=aggregate.h3_resolution,
        metric_name=aggregate.metric_name,
        cohort_count=aggregate.cohort_count,
    )
