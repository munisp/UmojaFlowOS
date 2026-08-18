import unittest
from umojaflowos_reporting.lakehouse import LakehouseContractError, build_bronze_manifest


class LakehouseContractTests(unittest.TestCase):
    def test_manifest_is_deterministic_for_identical_records(self):
        records = [{"corridor": "South Africa", "currency": "ZAR"}]
        self.assertEqual(build_bronze_manifest("settlement-events", records), build_bronze_manifest("settlement-events", records))

    def test_rejects_non_mapping_record(self):
        with self.assertRaises(LakehouseContractError):
            build_bronze_manifest("settlement-events", ["not-a-record"])
