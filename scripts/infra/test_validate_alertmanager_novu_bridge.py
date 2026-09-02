import json
import unittest

from validate_alertmanager_novu_bridge import transform


def alert(severity="critical", status="firing", labels=None, annotations=None):
    return {
        "status": status,
        "labels": {"alertname": "UmojaOTelCollectorDown", "severity": severity, "environment": "staging", "tenant_id": "tenant-a", **(labels or {})},
        "annotations": {"summary": "Collector down", "description": "Telemetry unavailable", **(annotations or {})},
        "startsAt": "2026-09-01T12:00:00Z",
        "fingerprint": "a" * 40,
    }


class NovuBridgeValidatorTests(unittest.TestCase):
    def test_critical_firing_routes_to_critical_workflow(self):
        output = transform({"receiver": "novu-critical-compliance", "status": "firing", "alerts": [alert()]})
        self.assertEqual(output["name"], "umoja-compliance-critical")
        self.assertEqual(output["payload"]["alert_count"], 1)
        self.assertEqual(output["payload"]["status"], "firing")

    def test_warning_routes_to_warning_workflow(self):
        output = transform({"receiver": "staging-warning-sink", "status": "firing", "alerts": [alert("warning")]})
        self.assertEqual(output["name"], "umoja-compliance-warning")

    def test_info_routes_to_info_workflow(self):
        output = transform({"receiver": "staging-audit-sink", "status": "resolved", "alerts": [alert("info", "resolved")]})
        self.assertEqual(output["name"], "umoja-compliance-info")

    def test_critical_wins_for_mixed_severity_batch(self):
        output = transform({"receiver": "novu-critical-compliance", "status": "firing", "alerts": [alert("warning"), alert("critical")]})
        self.assertEqual(output["name"], "umoja-compliance-critical")
        self.assertEqual(output["payload"]["alert_count"], 2)

    def test_tenant_label_is_preserved(self):
        output = transform({"receiver": "r", "status": "firing", "alerts": [alert(labels={"tenant_id": "tenant-42"})]})
        self.assertEqual(output["payload"]["alerts"][0]["labels"]["tenant_id"], "tenant-42")

    def test_sensitive_labels_and_annotations_are_removed(self):
        output = transform({"receiver": "r", "status": "firing", "alerts": [alert(labels={"account_id": "secret-account"}, annotations={"document": "private"})]})
        encoded = json.dumps(output)
        self.assertNotIn("secret-account", encoded)
        self.assertNotIn("private", encoded)

    def test_invalid_root_status_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "root.status"):
            transform({"receiver": "r", "status": "pending", "alerts": [alert()]})

    def test_empty_alerts_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "non-empty array"):
            transform({"receiver": "r", "status": "firing", "alerts": []})

    def test_missing_required_alert_fields_are_rejected(self):
        with self.assertRaisesRegex(ValueError, "missing required"):
            transform({"receiver": "r", "status": "firing", "alerts": [{"status": "firing", "labels": {}, "annotations": {}}]})

    def test_unsupported_severity_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "unsupported severity"):
            transform({"receiver": "r", "status": "firing", "alerts": [alert("emergency")]})

    def test_missing_summary_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "summary"):
            transform({"receiver": "r", "status": "firing", "alerts": [alert(annotations={"summary": ""})]})

    def test_non_object_root_is_rejected_by_cli_contract(self):
        self.assertRaises(ValueError, transform, [])


if __name__ == "__main__":
    unittest.main()
