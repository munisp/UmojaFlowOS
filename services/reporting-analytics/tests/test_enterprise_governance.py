import unittest

from enterprise_governance import summarize_enterprise_governance


class EnterpriseGovernanceReportingTests(unittest.TestCase):
    def test_summary_never_claims_external_authority(self):
        result = summarize_enterprise_governance([
            {"module_kind": "stablecoin_treasury", "review_status": "approved"},
            {"module_kind": "spend_card_programme", "review_status": "blocked"},
        ])
        self.assertEqual(result["record_count"], 2)
        self.assertFalse(result["stablecoin_transfer_initiated"])
        self.assertFalse(result["credit_decision_made"])
        self.assertFalse(result["card_issued"])
        self.assertFalse(result["authoritative_for_execution"])


if __name__ == "__main__":
    unittest.main()
