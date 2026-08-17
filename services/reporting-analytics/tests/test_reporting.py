import unittest

from umojaflowos_reporting import ReportValidationError, build_evidence_manifest, validate_report_pack


class ReportingTests(unittest.TestCase):
    def test_requires_regulator_specific_report_fields(self) -> None:
        with self.assertRaises(ReportValidationError):
            validate_report_pack({"regulator": "CBN", "corridor": "Nigeria"})

    def test_builds_hash_evidence_for_valid_regulator(self) -> None:
        manifest = build_evidence_manifest("SARB", b'{"report":"validated"}', 2)
        self.assertEqual(manifest.regulator, "SARB")
        self.assertEqual(manifest.record_count, 2)
        self.assertEqual(len(manifest.source_hash), 64)


if __name__ == "__main__":
    unittest.main()
