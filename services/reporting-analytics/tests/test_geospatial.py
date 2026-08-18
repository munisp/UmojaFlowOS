import pytest

from umojaflowos_reporting.geospatial import GeospatialContractError, build_jurisdiction_aggregation


def test_geospatial_aggregate_rejects_raw_coordinates_and_small_cohorts():
    with pytest.raises(GeospatialContractError):
        build_jurisdiction_aggregation("ZA", 9, 7, "payment_count", [])
    with pytest.raises(GeospatialContractError):
        build_jurisdiction_aggregation("ZA", 10, 7, "payment_count", [{"latitude": -26.2}])


def test_geospatial_aggregate_accepts_jurisdiction_level_cohort():
    result = build_jurisdiction_aggregation("ZA", 10, 7, "payment_count", [{"corridor": "SOUTH_AFRICA_ZAR"}])
    assert result.jurisdiction == "ZA"
