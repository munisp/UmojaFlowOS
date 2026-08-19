"""Generate a credential-free GeoLibre v0.1.0 project for aggregate data."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import urlparse


class GeoLibrePublicationError(ValueError):
    pass


@dataclass(frozen=True)
class GeoLibrePublication:
    project: dict[str, object]
    viewer_url: str


def build_aggregate_project(project_name: str, aggregate_data_url: str, viewer_base_url: str) -> GeoLibrePublication:
    data = urlparse(aggregate_data_url)
    viewer = urlparse(viewer_base_url)
    if not project_name.strip() or len(project_name) > 120:
        raise GeoLibrePublicationError("GeoLibre project name is required and must be at most 120 characters")
    if data.scheme != "https" or not data.hostname or data.username or data.password:
        raise GeoLibrePublicationError("GeoLibre aggregate data URL must be HTTPS and contain no embedded credentials")
    if viewer.scheme != "https" or not viewer.hostname or viewer.username or viewer.password:
        raise GeoLibrePublicationError("GeoLibre viewer URL must be HTTPS and contain no embedded credentials")
    lowered = aggregate_data_url.lower()
    if any(fragment in lowered for fragment in ("secret=", "token=", "password=", "access_key=")):
        raise GeoLibrePublicationError("GeoLibre data URL must not expose credential query parameters")
    project = {
        "version": "0.1.0",
        "name": project_name.strip(),
        "mapView": {"center": [24.0, 1.0], "zoom": 3.2, "bearing": 0, "pitch": 0},
        "basemapStyleUrl": "",
        "basemapVisible": False,
        "basemapOpacity": 1,
        "layers": [
            {
                "id": "jurisdiction-aggregate",
                "name": "Privacy-preserving jurisdiction aggregate",
                "type": "geojson",
                "source": {"type": "geojson", "url": aggregate_data_url},
                "visible": True,
                "opacity": 1,
                "metadata": {"classification": "aggregate_only", "minimum_cohort": 10},
            }
        ],
        "styles": {},
        "metadata": {"producer": "UmojaFlowOS", "data_policy": "aggregate_only_no_raw_locations_or_customer_data"},
    }
    separator = "&" if viewer.query else "?"
    viewer_url = f"{viewer_base_url.rstrip('/')}/{separator}url={aggregate_data_url}&layout=viewer"
    return GeoLibrePublication(project=project, viewer_url=viewer_url)
