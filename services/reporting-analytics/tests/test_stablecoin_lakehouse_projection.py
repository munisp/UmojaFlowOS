from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient

from umojaflowos_reporting import service


class RecordingWriter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[dict[str, object]]]] = []

    def write(self, dataset: str, records: list[dict[str, object]]):
        self.calls.append((dataset, records))
        return SimpleNamespace(payload_sha256="c" * 64), "bronze/payment-lifecycle-evidence/exposure.json", "created"


def request_payload() -> dict[str, object]:
    return {
        "as_of": "2026-08-19T00:00:00Z",
        "max_position_age_minutes": 60,
        "max_observation_age_minutes": 60,
        "positions": [
            {
                "corridor": "NIGERIA_NGN",
                "asset": "USDC",
                "account_reference": "internal-account-ref",
                "available_amount": "12.50",
                "reserved_amount": "0.50",
                "source_reference": "reconciled-source-ref",
                "reconciled_at": "2026-08-18T23:55:00Z",
            }
        ],
        "peg_observations": [
            {
                "asset": "USDC",
                "rate_to_usd": "1.00",
                "source_reference": "peg-source-ref",
                "observed_at": "2026-08-18T23:59:00Z",
            }
        ],
    }


def test_stablecoin_exposure_writes_only_redacted_catalog_evidence_when_enabled(monkeypatch) -> None:
    writer = RecordingWriter()
    monkeypatch.setenv("UMOJA_LAKEHOUSE_PROJECT_STABLECOIN_EXPOSURE", "true")
    monkeypatch.setattr(service, "configured_lakehouse_writer", lambda: writer)

    response = TestClient(service.app).post("/v1/treasury/stablecoin-exposure", json=request_payload())

    assert response.status_code == 200
    assert "lakehouse_projection" not in response.json()
    assert writer.calls[0][0] == "payment-lifecycle-evidence"
    record = writer.calls[0][1][0]
    assert record["source"] == "stablecoin_exposure"
    assert record["authoritative"] is False
    rendered = str(record)
    assert "12.50" not in rendered
    assert "internal-account-ref" not in rendered
    assert "reconciled-source-ref" not in rendered


def test_stablecoin_exposure_does_not_write_lakehouse_evidence_when_disabled(monkeypatch) -> None:
    writer = RecordingWriter()
    monkeypatch.delenv("UMOJA_LAKEHOUSE_PROJECT_STABLECOIN_EXPOSURE", raising=False)
    monkeypatch.setattr(service, "configured_lakehouse_writer", lambda: writer)

    response = TestClient(service.app).post("/v1/treasury/stablecoin-exposure", json=request_payload())

    assert response.status_code == 200
    assert writer.calls == []
