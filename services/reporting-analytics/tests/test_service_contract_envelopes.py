"""Service-level regressions for the two cross-language contract envelopes.

The module-level tests already prove the assembly and exposure arithmetic. What
these tests prove is different and was previously untested: that the FastAPI
responses are shaped exactly as the TypeScript control plane's strict contract
parsers require. Those parsers reject unknown fields, so an extra key here is a
failure and not a harmless addition — which is why the previous free-form
``{"report": ...}`` wrapper could never have been accepted at the boundary.
"""

from __future__ import annotations

import json
from datetime import datetime, timedelta, timezone

from fastapi.testclient import TestClient

from umojaflowos_reporting.service import (
    ASSEMBLED_REPORT_ENVELOPE,
    CONTRACT_VERSION,
    SERVICE_NAME,
    STABLECOIN_EXPOSURE_ENVELOPE,
    app,
)

client = TestClient(app)

# Keys the control plane refuses at any depth, because a service output must
# never carry execution authority or credentials.
FORBIDDEN_KEYS = {
    "execute",
    "execution_instruction",
    "settle",
    "settlement_instruction",
    "submit",
    "submission_instruction",
    "file_report",
    "transfer",
    "transfer_instruction",
    "provider_credential",
    "credential",
    "api_key",
}

# Exactly the fields the assembled-report contract declares. Both directions are
# asserted: a missing field fails the parse, and an extra field fails it too.
ASSEMBLED_REPORT_FIELDS = {
    "service",
    "contract_version",
    "envelope_type",
    "regulator",
    "corridor",
    "settlement_currency",
    "report_type",
    "period_start",
    "period_end",
    "regulated_entity_id",
    "generated_at",
    "totals",
    "artifact_digest",
    "submission_state",
}

EXPOSURE_FIELDS = {
    "service",
    "contract_version",
    "envelope_type",
    "generated_at",
    "total_usd_equivalent",
    "corridor_exposures",
    "observations",
}

EXPOSURE_LINE_FIELDS = {
    "corridor",
    "asset",
    "available_amount",
    "reserved_amount",
    "total_amount",
    "usd_equivalent",
    "peg_deviation_basis_points",
    "position_count",
    "source_references",
}


def _assert_no_execution_authority(value: object, path: str = "$") -> None:
    if isinstance(value, list):
        for index, entry in enumerate(value):
            _assert_no_execution_authority(entry, f"{path}[{index}]")
        return
    if not isinstance(value, dict):
        return
    for key, nested in value.items():
        assert key.lower() not in FORBIDDEN_KEYS, f"forbidden key at {path}.{key}"
        _assert_no_execution_authority(nested, f"{path}.{key}")


def response_text(body: object) -> str:
    """Serialise a response body for substring assertions."""
    return json.dumps(body)


def _sarb_assembly_request() -> dict[str, object]:
    return {
        "regulator": "SARB",
        "report_type": "cross_border_settlement_return",
        "period_start": "2026-01-01",
        "period_end": "2026-01-31",
        "regulated_entity_id": "entity-under-test",
        "transactions": [
            {
                "transaction_reference": "txn-inbound-1",
                "value_date": "2026-01-05",
                "currency": "ZAR",
                "amount": "1000.00",
                "direction": "inbound",
                "counterparty_reference": "cp-1",
            },
            {
                "transaction_reference": "txn-outbound-1",
                "value_date": "2026-01-06",
                "currency": "ZAR",
                "amount": "250.00",
                "direction": "outbound",
                "counterparty_reference": "cp-2",
            },
        ],
    }


def test_assembled_report_envelope_matches_the_published_contract_exactly() -> None:
    response = client.post("/v1/reports/assemble", json=_sarb_assembly_request())
    assert response.status_code == 200
    body = response.json()

    assert set(body) == ASSEMBLED_REPORT_FIELDS
    assert body["service"] == SERVICE_NAME
    assert body["contract_version"] == CONTRACT_VERSION
    assert body["envelope_type"] == ASSEMBLED_REPORT_ENVELOPE
    # The regulator must be paired with the corridor it actually supervises; the
    # control plane rejects a mismatch as a mis-filed return.
    assert body["regulator"] == "SARB"
    assert body["corridor"] == "SOUTH_AFRICA_ZAR"
    assert body["settlement_currency"] == "ZAR"
    assert set(body["totals"]) == {
        "record_count",
        "inbound_total",
        "outbound_total",
        "net_total",
    }
    assert body["totals"]["record_count"] == 2
    assert len(body["artifact_digest"]) == 64
    _assert_no_execution_authority(body)


def test_assembled_report_is_never_declared_submitted() -> None:
    body = client.post("/v1/reports/assemble", json=_sarb_assembly_request()).json()
    # A submitted state would let an assembler assert a regulator filing that no
    # authorised channel has acknowledged.
    assert body["submission_state"] == "assembled_pending_review"
    assert "submitted" not in response_text(body)


def test_assembled_report_envelope_carries_no_row_level_customer_data() -> None:
    body = client.post("/v1/reports/assemble", json=_sarb_assembly_request()).json()
    # Row detail stays inside the service. The envelope carries recomputed totals
    # and a digest, so the boundary transfers no per-transaction counterparty data.
    assert "rows" not in body
    assert "cp-1" not in response_text(body)


def test_mismatched_currency_fails_closed_rather_than_assembling() -> None:
    request = _sarb_assembly_request()
    request["transactions"][0]["currency"] = "NGN"
    response = client.post("/v1/reports/assemble", json=request)
    assert response.status_code == 422
    assert "settlement currency" in response.json()["detail"]


def _exposure_request() -> dict[str, object]:
    now = datetime.now(timezone.utc)
    recent = (now - timedelta(minutes=5)).isoformat()
    return {
        "as_of": now.isoformat(),
        "max_position_age_minutes": 60,
        "max_observation_age_minutes": 60,
        "positions": [
            {
                "corridor": "NIGERIA_NGN",
                "asset": "USDC",
                "account_reference": "custody-ngn-1",
                "available_amount": "1000.000000",
                "reserved_amount": "0.000000",
                "source_reference": "recon-ngn-1",
                "reconciled_at": recent,
            }
        ],
        "peg_observations": [
            {
                "asset": "USDC",
                "rate_to_usd": "1.0000",
                "source_reference": "peg-usdc-1",
                "observed_at": recent,
            }
        ],
    }


def test_stablecoin_exposure_envelope_matches_the_published_contract_exactly() -> None:
    response = client.post("/v1/treasury/stablecoin-exposure", json=_exposure_request())
    assert response.status_code == 200
    body = response.json()

    assert set(body) == EXPOSURE_FIELDS
    assert body["service"] == SERVICE_NAME
    assert body["envelope_type"] == STABLECOIN_EXPOSURE_ENVELOPE
    assert len(body["corridor_exposures"]) == 1
    line = body["corridor_exposures"][0]
    assert set(line) == EXPOSURE_LINE_FIELDS
    assert line["corridor"] == "NIGERIA_NGN"
    assert line["asset"] == "USDC"
    # Source references must be a JSON array the contract can require to be
    # non-empty; a tuple serialised as a string would defeat that check.
    assert line["source_references"] == ["recon-ngn-1"]
    assert line["position_count"] == 1
    _assert_no_execution_authority(body)


def test_stale_position_fails_closed_rather_than_reporting_exposure() -> None:
    request = _exposure_request()
    stale = (datetime.now(timezone.utc) - timedelta(days=3)).isoformat()
    request["positions"][0]["reconciled_at"] = stale
    response = client.post("/v1/treasury/stablecoin-exposure", json=request)
    assert response.status_code == 422


def test_missing_peg_observation_fails_closed_rather_than_assuming_parity() -> None:
    request = _exposure_request()
    request["peg_observations"] = []
    response = client.post("/v1/treasury/stablecoin-exposure", json=request)
    # A missing peg observation must not be silently treated as 1.00 USD.
    assert response.status_code == 422
