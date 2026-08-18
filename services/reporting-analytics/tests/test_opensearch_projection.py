import unittest
from umojaflowos_reporting.opensearch_projection import SearchProjectionError, build_audit_projection


class OpenSearchProjectionTests(unittest.TestCase):
    def test_projects_redacted_audit_evidence_only(self):
        projection = build_audit_projection({"event_id": "evt-1", "action": "policy.evaluated", "object_type": "payment_order", "occurred_at": "2026-08-18T00:00:00Z", "metadata": {"corridor": "South Africa"}})
        self.assertEqual(projection.index, "umojaflowos-audit-v1")

    def test_rejects_monetary_or_secret_metadata(self):
        with self.assertRaises(SearchProjectionError):
            build_audit_projection({"event_id": "evt-1", "action": "x", "object_type": "x", "occurred_at": "t", "metadata": {"amount": "1"}})
