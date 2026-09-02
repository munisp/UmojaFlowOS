import json
import unittest

from validate_alertmanager_novu_bridge import transform


def make_alert(tenant_id="tenant-a", severity="critical", status="firing", fingerprint=None, **extra_labels):
    return {
        "status": status,
        "labels": {
            "alertname": "UmojaComplianceTelemetryMissing",
            "severity": severity,
            "environment": "staging",
            "tenant_id": tenant_id,
            **extra_labels,
        },
        "annotations": {
            "summary": "Telemetry missing",
            "description": "Collector refused telemetry",
        },
        "startsAt": "2026-09-01T12:00:00Z",
        "fingerprint": fingerprint or ("a" * 40),
    }


class NovuMultiTenantFailureTests(unittest.TestCase):
    def test_single_tenant_batch_is_scoped(self):
        result = transform({"receiver": "novu-critical-compliance", "status": "firing", "alerts": [make_alert()]})
        self.assertEqual(result["payload"]["tenant_id"], "tenant-a")
        self.assertTrue(all(a["labels"]["tenant_id"] == "tenant-a" for a in result["payload"]["alerts"]))

    def test_mixed_tenant_batch_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "exactly one tenant_id"):
            transform({"receiver": "r", "status": "firing", "alerts": [make_alert("tenant-a"), make_alert("tenant-b", fingerprint="b" * 40)]})

    def test_missing_tenant_is_rejected(self):
        item = make_alert()
        del item["labels"]["tenant_id"]
        with self.assertRaisesRegex(ValueError, "tenant_id"):
            transform({"receiver": "r", "status": "firing", "alerts": [item]})

    def test_blank_tenant_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "tenant_id"):
            transform({"receiver": "r", "status": "firing", "alerts": [make_alert(" ")]})

    def test_tenant_cannot_be_inferred_from_sensitive_fields(self):
        result = transform({"receiver": "r", "status": "firing", "alerts": [make_alert(labels={"account_id": "account-a"})]})
        self.assertEqual(result["payload"]["tenant_id"], "tenant-a")
        self.assertNotIn("account-a", json.dumps(result))

    def test_resolved_event_remains_tenant_scoped(self):
        result = transform({"receiver": "novu-critical-compliance", "status": "resolved", "alerts": [make_alert(status="resolved")]})
        self.assertEqual(result["payload"]["status"], "resolved")
        self.assertEqual(result["payload"]["tenant_id"], "tenant-a")

    def test_missing_alert_object_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "missing required"):
            transform({"receiver": "r", "status": "firing", "alerts": [None]})

    def test_invalid_alert_status_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "invalid"):
            transform({"receiver": "r", "status": "firing", "alerts": [make_alert(status="pending")]})

    def test_sensitive_annotation_is_removed(self):
        result = transform({"receiver": "r", "status": "firing", "alerts": [make_alert(document="restricted")]})
        self.assertNotIn("restricted", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
