import unittest

from enterprise_governance import summarize_enterprise_governance, summarize_vasp_readiness


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

    def test_vasp_summary_never_claims_external_authority(self):
        result = summarize_vasp_readiness([
            {
                "category": "aml_cft_cpf_and_travel_rule_programme",
                "route_state": "incomplete",
                "missing_category": "counterparty_identity_and_authorisation",
            }
        ])
        self.assertEqual(result["missing_categories"], ["counterparty_identity_and_authorisation"])
        self.assertFalse(result["external_submission_initiated"])
        self.assertFalse(result["travel_rule_transmission"])
        self.assertFalse(result["provider_activation_initiated"])
        self.assertFalse(result["custody_initiated"])
        self.assertFalse(result["value_movement_initiated"])
        self.assertFalse(result["authoritative_for_execution"])


if __name__ == "__main__":
    unittest.main()
