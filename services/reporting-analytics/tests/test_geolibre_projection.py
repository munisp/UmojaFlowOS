import unittest

from umojaflowos_reporting.geolibre_projection import GeoLibreProjectionError, build_geolibre_layer
from umojaflowos_reporting.geospatial import JurisdictionAggregation


class GeoLibreProjectionTests(unittest.TestCase):
    def test_projects_only_privacy_safe_aggregate(self):
        layer = build_geolibre_layer(JurisdictionAggregation("NG", 10, 7, "payment_volume"))
        self.assertEqual(layer.source_kind, "h3_aggregate")
        self.assertEqual(layer.jurisdiction, "NG")

    def test_rejects_small_cohort(self):
        with self.assertRaises(GeoLibreProjectionError):
            build_geolibre_layer(JurisdictionAggregation("KE", 9, 7, "payment_volume"))


if __name__ == "__main__":
    unittest.main()
