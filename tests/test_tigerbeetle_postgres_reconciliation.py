from __future__ import annotations

import os
import subprocess
import uuid
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
DB_URL = os.environ.get("RECONCILIATION_TEST_DATABASE_URL") or os.environ.get(
    "AUDIT_DATABASE_URL"
)

pytestmark = pytest.mark.skipif(
    not DB_URL,
    reason="RECONCILIATION_TEST_DATABASE_URL is required for PostgreSQL integration tests",
)


def psql(*args: str, sql: str | None = None) -> str:
    command = ["psql", DB_URL, "-X", "-v", "ON_ERROR_STOP=1", *args]
    if sql is not None:
        command.extend(["-c", sql])
    return subprocess.run(
        command,
        check=True,
        text=True,
        capture_output=True,
    ).stdout


def run_reconciliation(run_reference: str, start: str, end: str) -> subprocess.CompletedProcess[str]:
    env = {
        **os.environ,
        "AUDIT_DATABASE_URL": DB_URL,
        "RECONCILIATION_ALLOW_INSECURE_LOOPBACK": "true",
        "RECONCILIATION_SOURCE_IDENTITY": "pytest-reconciliation",
        "WINDOW_START": start,
        "WINDOW_END": end,
        "RUN_REFERENCE": run_reference,
    }
    return subprocess.run(
        ["bash", str(ROOT / "scripts/infra/reconcile_tigerbeetle_postgres.sh")],
        cwd=ROOT,
        env=env,
        text=True,
        capture_output=True,
    )


def insert_fixture(prefix: str, *, intent: bool, fact: bool, amount: int = 1000) -> tuple[str, str, str]:
    identity = f"pytest-{prefix}-{uuid.uuid4()}"
    correlation = f"pytest-correlation-{uuid.uuid4()}"
    transfer_id = str(8_800_000_000 + (uuid.uuid4().int % 100_000_000))
    sql = f"""
    INSERT INTO ledger_account_bindings
      (account_reference, tigerbeetle_account_id, account_kind, currency,
       evidence_uri, evidence_sha256, created_by)
    VALUES
      ('{identity}-debit', {transfer_id}::bigint + 1, 'customer_safeguarded', 'NGN',
       'https://example.invalid/{identity}-debit', repeat('a', 64), 'pytest')
    ON CONFLICT DO NOTHING;
    INSERT INTO ledger_account_bindings
      (account_reference, tigerbeetle_account_id, account_kind, currency,
       evidence_uri, evidence_sha256, created_by)
    VALUES
      ('{identity}-credit', {transfer_id}::bigint + 2, 'settlement_asset', 'NGN',
       'https://example.invalid/{identity}-credit', repeat('b', 64), 'pytest')
    ON CONFLICT DO NOTHING;
    """
    if intent:
        sql += f"""
        INSERT INTO ledger_posting_intents
          (posting_identity, correlation_id, currency, amount_minor,
           debit_account_id, credit_account_id, expected_transfer_id)
        VALUES ('{identity}', '{correlation}', 'NGN', {amount},
                {transfer_id}::bigint + 1, {transfer_id}::bigint + 2,
                {transfer_id}::bigint)
        ON CONFLICT DO NOTHING;
        """
    if fact:
        sql += f"""
        INSERT INTO tigerbeetle_transfer_facts
          (tigerbeetle_transfer_id, correlation_id, currency, amount_minor,
           debit_account_id, credit_account_id, posted_at, evidence_sha256)
        VALUES ({transfer_id}::bigint, '{correlation}', 'NGN', {amount},
                {transfer_id}::bigint + 1, {transfer_id}::bigint + 2,
                now(), repeat('c', 64))
        ON CONFLICT DO NOTHING;
        """
    psql(sql=sql)
    return identity, correlation, transfer_id


def test_missing_intent_fact_is_recorded() -> None:
    run_reference = f"pytest-missing-{uuid.uuid4()}"
    identity, _, _ = insert_fixture("missing", intent=True, fact=False)
    result = run_reconciliation(run_reference, "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")
    assert result.returncode != 0
    assert "reconciliation_status=discrepancy" in result.stderr
    row = psql(sql=f"SELECT discrepancy_code FROM ledger_reconciliation_discrepancies d JOIN ledger_reconciliation_runs r ON r.id=d.run_id WHERE r.run_reference='{run_reference}' AND d.posting_identity='{identity}'")
    assert "missing_fact" in row


def test_unexpected_fact_is_recorded() -> None:
    run_reference = f"pytest-unexpected-{uuid.uuid4()}"
    _, _, transfer_id = insert_fixture("unexpected", intent=False, fact=True)
    result = run_reconciliation(run_reference, "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")
    assert result.returncode != 0
    row = psql(sql=f"SELECT discrepancy_code FROM ledger_reconciliation_discrepancies d JOIN ledger_reconciliation_runs r ON r.id=d.run_id WHERE r.run_reference='{run_reference}' AND d.tigerbeetle_transfer_id={transfer_id}")
    assert "unexpected_fact" in row


def test_field_mismatch_is_recorded() -> None:
    run_reference = f"pytest-mismatch-{uuid.uuid4()}"
    identity, _, transfer_id = insert_fixture("mismatch", intent=True, fact=True, amount=1000)
    psql(sql=f"UPDATE tigerbeetle_transfer_facts SET amount_minor=1001 WHERE tigerbeetle_transfer_id={transfer_id}")
    result = run_reconciliation(run_reference, "2000-01-01T00:00:00Z", "2100-01-01T00:00:00Z")
    assert result.returncode != 0
    row = psql(sql=f"SELECT discrepancy_code FROM ledger_reconciliation_discrepancies d JOIN ledger_reconciliation_runs r ON r.id=d.run_id WHERE r.run_reference='{run_reference}' AND d.posting_identity='{identity}'")
    assert "field_mismatch" in row
