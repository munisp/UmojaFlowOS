from __future__ import annotations

from types import SimpleNamespace

from fastapi.testclient import TestClient

from umojaflowos_reporting import service


class RecordingWriter:
    def __init__(self) -> None:
        self.calls: list[tuple[str, list[dict[str, object]]]] = []

    def write(self, dataset: str, records: list[dict[str, object]]):
        self.calls.append((dataset, records))
        return SimpleNamespace(payload_sha256="a" * 64), "bronze/payment-lifecycle-evidence/catalog.json", "created"


def catalog_evidence(source: str = "go_payment_engine") -> dict[str, object]:
    return {
        "source": source,
        "event_type": "umojaflowos.payment.order.validated.v1",
        "observed_at": "2026-08-19T00:00:00Z",
        "correlation_sha256": "b" * 64,
        "outcome": "approved",
        "corridor": "NIGERIA_NGN",
    }


def configure_catalog(monkeypatch, writer: RecordingWriter) -> str:
    key = "local" + "-catalog-" + "key"
    monkeypatch.setenv("UMOJA_LAKEHOUSE_CATALOG_INGESTION_ENABLED", "true")
    monkeypatch.setenv("UMOJA_LAKEHOUSE_CATALOG_GO_PAYMENT_ENGINE_KEY", key)
    monkeypatch.setattr(service, "configured_lakehouse_writer", lambda: writer)
    return key


def test_catalog_endpoint_is_disabled_without_explicit_configuration(monkeypatch) -> None:
    monkeypatch.delenv("UMOJA_LAKEHOUSE_CATALOG_INGESTION_ENABLED", raising=False)
    response = TestClient(service.app).post(
        "/v1/lakehouse/catalog/go_payment_engine",
        json={"evidence": catalog_evidence()},
    )
    assert response.status_code == 503


def test_catalog_endpoint_requires_the_source_specific_secret(monkeypatch) -> None:
    writer = RecordingWriter()
    configure_catalog(monkeypatch, writer)
    response = TestClient(service.app).post(
        "/v1/lakehouse/catalog/go_payment_engine",
        json={"evidence": catalog_evidence()},
        headers={"X-Umoja-Lakehouse-Key": "wrong"},
    )
    assert response.status_code == 403
    assert writer.calls == []


def test_catalog_endpoint_refuses_a_body_that_claims_a_different_source(monkeypatch) -> None:
    writer = RecordingWriter()
    key = configure_catalog(monkeypatch, writer)
    response = TestClient(service.app).post(
        "/v1/lakehouse/catalog/go_payment_engine",
        json={"evidence": catalog_evidence("rust_risk")},
        headers={"X-Umoja-Lakehouse-Key": key},
    )
    assert response.status_code == 422
    assert writer.calls == []


def test_catalog_endpoint_writes_one_strict_non_authoritative_record(monkeypatch) -> None:
    writer = RecordingWriter()
    key = configure_catalog(monkeypatch, writer)
    response = TestClient(service.app).post(
        "/v1/lakehouse/catalog/go_payment_engine",
        json={"evidence": catalog_evidence()},
        headers={"X-Umoja-Lakehouse-Key": key},
    )
    assert response.status_code == 200
    assert response.json()["status"] == "recorded"
    assert response.json()["authoritative"] is False
    assert writer.calls[0][0] == "payment-lifecycle-evidence"
    assert writer.calls[0][1][0]["authoritative"] is False
