import json
import tempfile
from pathlib import Path

from validate_alertmanager_novu_bridge import transform


def main() -> None:
    payload = {
        "receiver": "novu-critical-compliance",
        "status": "firing",
        "alerts": [{
            "status": "firing",
            "labels": {"alertname": "UmojaOTelCollectorDown", "severity": "critical", "environment": "staging", "tenant_id": "tenant-a", "account_id": "must-not-leak"},
            "annotations": {"summary": "Collector down", "description": "Telemetry is unavailable", "document": "must-not-leak"},
            "startsAt": "2026-09-01T12:00:00Z",
            "fingerprint": "a" * 40,
        }],
    }
    output = transform(payload)
    assert output["name"] == "umoja-compliance-critical"
    encoded = json.dumps(output)
    assert "must-not-leak" not in encoded
    assert output["payload"]["alerts"][0]["labels"]["tenant_id"] == "tenant-a"
    try:
        transform({"receiver": "x", "status": "firing", "alerts": [{"labels": {"severity": "critical"}}]})
    except ValueError:
        pass
    else:
        raise AssertionError("malformed payload was accepted")
    with tempfile.TemporaryDirectory() as directory:
        Path(directory, "mock-alertmanager.json").write_text(json.dumps(payload), encoding="utf-8")
    print("Novu bridge transformation self-test: PASS")


if __name__ == "__main__":
    main()
