import unittest
from trade_payment_control import summarize_trade_cases


class TradePaymentControlReportTests(unittest.TestCase):
    def test_summary_is_non_authoritative_and_does_not_claim_execution(self):
        result = summarize_trade_cases([{"case_reference": "TPC-NG-001", "status": "blocked"}])
        self.assertEqual(result["blocked_case_references"], ["TPC-NG-001"])
        self.assertFalse(result["provider_execution_initiated"])
        self.assertFalse(result["settlement_asserted"])
        self.assertFalse(result["authoritative_for_execution"])


if __name__ == "__main__":
    unittest.main()
