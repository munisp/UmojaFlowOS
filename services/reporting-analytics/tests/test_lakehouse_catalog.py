from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

import pytest

from umojaflowos_reporting.lakehouse import LakehouseContractError
from umojaflowos_reporting.lakehouse_catalog import CATALOG_SOURCES, build_catalog_evidence, write_catalog_evidence


def raw(source: str) -> dict[str, object]:
    return {
        "source": source,
        "event_type": "evidence.recorded",
        "observed_at": "2026-08-19T12:00:00Z",
        "correlation_sha256": "a" * 64,
        "outcome": "recorded",
        "corridor": "NIGERIA_NGN",
        "stablecoin": "USDC",
        "model_role": "review_only",
    }


def test_every_core_source_can_emit_a_redacted_non_authoritative_catalog_record() -> None:
    for source in CATALOG_SOURCES:
        evidence = build_catalog_evidence(raw(source))
        record = evidence.to_record()
        assert record["source"] == source
        assert record["authoritative"] is False
        assert record["correlation_sha256"] == "a" * 64
        assert record["stablecoin"] == "USDC"


@pytest.mark.parametrize(
    "field,value",
    [
        ("customer_id", "not-allowed"),
        ("wallet_address", "not-allowed"),
        ("provider_token", "not-allowed"),
        ("execute_transfer", False),
        ("authoritative", True),
        ("correlation_sha256", "raw-provider-id"),
        ("stablecoin", "DAI"),
        ("observed_at", "2026-08-19T12:00:00"),
    ],
)
def test_catalog_rejects_direct_identifiers_secrets_execution_authority_and_unsupported_assets(field: str, value: object) -> None:
    record = raw("stablecoin_exposure")
    record[field] = value
    with pytest.raises(LakehouseContractError):
        build_catalog_evidence(record)


class FakeWriter:
    def __init__(self) -> None:
        self.dataset: str | None = None
        self.records: list[dict[str, object]] | None = None

    def write(self, dataset: str, records: list[dict[str, object]]) -> Any:
        self.dataset = dataset
        self.records = records
        return type("Manifest", (), {"payload_sha256": "b" * 64})(), "bronze/object.jsonl", "created"


def test_catalog_writes_only_the_governed_projection() -> None:
    writer = FakeWriter()
    digest, location = write_catalog_evidence(writer, raw("temporal_workflow"))  # type: ignore[arg-type]
    assert digest == "b" * 64
    assert location == "bronze/object.jsonl:created"
    assert writer.dataset == "payment-lifecycle-evidence"
    assert writer.records == [
        {
            "schema_version": "v1",
            "source": "temporal_workflow",
            "event_type": "evidence.recorded",
            "observed_at": datetime(2026, 8, 19, 12, 0, tzinfo=timezone.utc).isoformat().replace("+00:00", "Z"),
            "correlation_sha256": "a" * 64,
            "outcome": "recorded",
            "authoritative": False,
            "corridor": "NIGERIA_NGN",
            "stablecoin": "USDC",
            "model_role": "review_only",
        }
    ]
