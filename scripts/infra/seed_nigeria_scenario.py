#!/usr/bin/env python3
"""Seed deterministic, synthetic Nigerian financial-regulatory scenarios into PostgreSQL.

The engine is deliberately synthetic: it never imports real customer, UBO, KYC,
sanctions, or payment data. It introspects the target schema and seeds every
insertable table in a non-production database. Use --dry-run first.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any, Iterable

SCENARIO_VERSION = "nigeria-cbn-vasp-v1"
FORBIDDEN_ENVIRONMENTS = {"production", "prod", "live"}
DEFAULT_TENANT = "synthetic-cbn-cohort2"

@dataclass(frozen=True)
class Column:
    name: str
    data_type: str
    udt_name: str
    nullable: bool
    default: str | None
    is_identity: bool
    is_generated: bool
    ordinal: int

@dataclass(frozen=True)
class Table:
    schema: str
    name: str
    columns: tuple[Column, ...]


def stable_uuid(seed: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"https://synthetic.umoja.invalid/{SCENARIO_VERSION}/{seed}"))


def stable_hex(seed: str, length: int = 64) -> str:
    return hashlib.sha256(f"{SCENARIO_VERSION}:{seed}".encode()).hexdigest()[:length]


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).isoformat().replace("+00:00", "Z")


def quote_ident(value: str) -> str:
    return '"' + value.replace('"', '""') + '"'


def is_insertable(column: Column) -> bool:
    if column.is_identity or column.is_generated:
        return False
    if column.default:
        default = column.default.lower()
        if "gen_random_uuid" in default or "uuid_generate" in default:
            return column.udt_name == "uuid"
        return False
    return True


def business_value(table: Table, column: Column, row_no: int, now: datetime, enum_values: dict[str, tuple[str, ...]] | None = None, check_values: dict[tuple[str, str], tuple[str, ...]] | None = None) -> Any:
    n = column.name.lower()
    t = table.name.lower()
    if t == "operator_role_assignments" and n == "role":
        return ["provider_contact", "cbn_liaison"][row_no % 2]
    if t == "external_stakeholder_assignments" and n == "stakeholder_role":
        return "provider_contact" if row_no == 1 else "cbn_liaison"
    if t == "spend_card_programmes" and n == "programme_reference":
        return f"SCP-NG-{row_no:03d}"
    if t == "supply_chain_finance_programmes" and n == "programme_reference":
        return f"SCF-NG-{row_no:03d}"
    if t == "trade_cases" and n == "case_reference":
        return f"TPC-NG-{row_no:03d}"
    if t == "rate_locks" and n == "base_asset":
        return "NGN"
    if t == "rate_locks" and n == "quote_asset":
        return "USD"
    if t == "market_observations" and n == "base_asset":
        return "NGN"
    if t == "market_observations" and n == "quote_asset":
        return "USD"
    if t == "ledger_account_bindings" and n == "tigerbeetle_account_id":
        return 100000 + row_no
    if t == "treasury_rebalancing_recommendations":
        if n == "status":
            return "approved"
        if n == "reconciled_available_balance":
            return Decimal("250000")
        if n == "verified_near_term_funding_gap":
            return Decimal("50000")
        if n == "minimum_buffer_amount":
            return Decimal("100000")
        if n == "target_buffer_amount":
            return Decimal("200000")
        if n == "computed_recommendation_amount":
            return Decimal("150000")
        if n == "decision_reason":
            return "Synthetic approval for local staging scenario."
    if t == "treasury_stress_test_runs":
        if n == "outflow_multiplier":
            return Decimal("1.250000")
        if n == "input_status":
            return "completed"

    if t == "tigerbeetle_transfer_facts":
        if n == "tigerbeetle_transfer_id":
            return 900000 + row_no
        if n == "debit_account_id":
            return 100000 + row_no
        if n == "credit_account_id":
            return 100000 + (3 - row_no)
        if n == "reconciliation_state":
            return "pending"
        if n == "reconciliation_reference":
            return None
    if t == "ledger_posting_intents":
        if n == "debit_account_id":
            return 100000 + row_no
        if n == "credit_account_id":
            return 100000 + (3 - row_no)
        if n == "expected_transfer_id":
            return 900000 + row_no
        if n == "intent_state":
            return "approved"
    if t == "counterparty_risk_assessments":
        if n == "risk_level":
            return "low"
        if n == "review_status":
            return "current"
        if n == "assessed_at":
            return iso(now - timedelta(days=1))
        if n == "next_review_at":
            return iso(now + timedelta(days=30))
        if n in {"escalation_reason", "escalated_by", "escalated_at"}:
            return None
    if t == "super_administrator_assignments":
        if n == "status":
            return "active"
        if n in {"revoked_by", "revoked_at", "revocation_reason"}:
            return None
    if t == "cbn_sandbox_dossiers" and n == "external_submission_reference":
        return None
    if t == "document_analysis_jobs":
        if n == "completed_at":
            return None
        if n == "selected_model_tag":
            return "local-staging-model-v1"
        if n == "selected_model_digest":
            return stable_hex(f"{table.schema}.{table.name}.selected_model_digest.{row_no}")
        if n == "selected_model_role":
            return "visual_primary"
    if t == "cbn_sandbox_test_plans":
        if n == "permitted_use":
            return "Synthetic controlled VASP sandbox transaction testing for local staging."
        if n == "max_transactions":
            return 10
        if n == "max_aggregate_exposure":
            return Decimal("250000")
        if n == "starts_at":
            return iso(now - timedelta(days=1))
        if n == "ends_at":
            return iso(now + timedelta(days=30))
    if t == "cbn_sandbox_incidents" and n == "submission_reference":
        return None
    if t == "cbn_sandbox_reporting_packs":
        if n == "period_start":
            return iso(now - timedelta(days=1))
        if n == "period_end":
            return iso(now)
        if n == "submission_status":
            return "not_submitted"
        if n == "submission_reference":
            return None
    if t == "cbn_sandbox_incidents" and n == "notification_status":
        return "not_submitted"
    if t == "cbn_sandbox_dossiers" and n == "status":
        return "draft"
    if t == "administrator_kyc_evidence" and n == "jurisdiction_exception_rationale":
        return None
    if t == "trade_case_evidence":
        if n in {"reviewed_by", "review_rationale", "reviewed_at"}:
            return None
        if n == "review_status":
            return "submitted"
    if t == "trade_case_exceptions":
        if n == "status":
            return "open"
        if n in {"resolved_by", "resolved_at", "resolution_rationale"}:
            return None
    if t == "vasp_readiness_assurance_items":
        if n == "max_points":
            return 7
        if n == "required_evidence":
            return "Signed staging evidence and independent verification record required before release approval."
        if n == "status":
            return "open"
        if n in {"evidence_uri", "evidence_sha256", "evidence_recorded_by", "evidence_recorded_at", "external_verifier", "external_attestation_uri", "external_attestation_sha256", "verified_by", "verified_at", "verification_rationale", "rejection_rationale"}:
            return None
    if t == "cbn_sandbox_evidence_assessments":
        if n in {"required_categories", "recorded_categories", "missing_categories", "inconsistency_codes"}:
            return []
        if n in {"external_eligibility", "external_submission", "admission", "licence", "provider_activation", "documented_test_plan"}:
            return False
    if t == "administrator_kyc_review_entries" and n == "review_sequence":
        return 1 if row_no == 1 else 2
    if t == "administrator_kyc_evidence_requests":
        if n == "status":
            return "open"
        if n in {"resolved_at", "closed_by"}:
            return None
    if t == "counterparty_onboardings" and n == "country_overlays":
        return ["NIGERIA_NGN"]
    if t == "treasury_buffer_policies" and n == "corridor":
        return "NIGERIA_NGN"
    if t == "treasury_buffer_policies" and n == "currency":
        return "NGN"
    if t == "segregation_of_duties_evaluation_runs":
        if n == "evaluator_role":
            return "reconciliation_reviewer"
        if n == "evaluation_state":
            return "clean"
        if n == "exception_count":
            return 0
        if n == "exception_digest":
            return stable_hex(f"{table.schema}.{table.name}.exception_digest.{row_no}")
        if n == "error_summary":
            return None
    if column.data_type == "USER-DEFINED" and enum_values and column.udt_name in enum_values:
        values = enum_values[column.udt_name]
        return values[(row_no - 1) % len(values)]
    seed = f"{table.schema}.{table.name}.{column.name}.{row_no}"
    if t == "treasury_buffer_policies":
        if n == "corridor":
            return "NIGERIA_NGN"
        if n == "currency":
            return "NGN"
        if n == "minimum_buffer_pct":
            return Decimal("0.10")
        if n == "amber_buffer_pct":
            return Decimal("0.15")
        if n == "target_buffer_pct":
            return Decimal("0.20")
        if n == "max_recommendation_pct_of_target":
            return Decimal("0.10")
        if n == "approved_daily_outflow":
            return Decimal("250000")
        if n == "permitted_account_kinds":
            return ["customer", "treasury"]
        if n == "source_period_start":
            return (now.date() - timedelta(days=30)).isoformat()
        if n == "source_period_end":
            return now.date().isoformat()
        if n == "effective_to":
            return None
    if column.data_type in ("timestamp without time zone", "timestamp with time zone"):
        if n == "expires_at":
            return iso(now + timedelta(days=1))
        if n == "window_start":
            return iso(now - timedelta(hours=2 + row_no))
        if n == "window_end":
            return iso(now - timedelta(hours=1 + row_no))
        return iso(now - timedelta(hours=(row_no * 3) % 72))
    if column.data_type == "date":
        return (now.date() - timedelta(days=row_no % 30)).isoformat()
    if column.data_type == "boolean":
        return row_no % 2 == 1
    if column.data_type == "ARRAY" or column.udt_name.startswith("_"):
        return []
    if t == "ledger_reconciliation_runs":
        if n == "status":
            return "reconciled"
        if n == "discrepancy_count":
            return 0
        if n == "error_summary":
            return None
    if t == "control_evidence_outbox":
        if n == "source":
            return "postgresql_control"
        if n == "event_type":
            return "umojaflowos.counterparty.onboarding.created.v1"
        if n == "outcome":
            return "created"
        if n == "payload":
            return {"authoritative": "false", "scenario": SCENARIO_VERSION}
    if check_values and (table.name, column.name) in check_values:
        values = check_values[(table.name, column.name)]
        return values[(row_no - 1) % len(values)]
    if t == "adapter_certification_evidence":
        if n == "adapter_kind":
            return ["bank_treasury", "reconciliation"][row_no % 2]
        if n == "asset":
            return ["NGN", "USD"][row_no % 2]
        if n == "external_execution_initiated":
            return False
    if "json" in column.data_type or column.udt_name in ("json", "jsonb"):
        return {"scenario": SCENARIO_VERSION, "synthetic": True, "table": t, "row": row_no}
    if (n in {"id", "uuid", "record_id", "event_id", "case_id", "customer_id", "account_id", "order_id", "run_id", "request_id", "evidence_id", "document_id"} or n.endswith("_id")) and column.udt_name == "uuid":
        return stable_uuid(seed)
    if n == "window_start":
        return iso(now - timedelta(hours=2 + row_no))
    if n == "window_end":
        return iso(now - timedelta(hours=1 + row_no))
    if "file_bytes" in n or "max_bytes" in n:
        return 10485760
    if column.data_type in ("smallint", "integer", "bigint", "numeric", "decimal", "real", "double precision"):
        if any(x in n for x in ("count", "quantity", "attempt", "priority", "score", "level")):
            return row_no + 1
        if any(x in n for x in ("percent", "percentage", "ratio", "rate", "pct")):
            return Decimal("12.50")
        if any(x in n for x in ("amount", "value", "limit", "balance", "fee", "volume", "outflow", "inflow")):
            return Decimal(str([125000, 250000, 500000, 1000000][row_no % 4]))
        return row_no + 1
    if any(x in n for x in ("created_at", "updated_at", "occurred_at", "submitted_at", "approved_at", "effective_at", "observed_at", "received_at", "started_at", "completed_at", "resolved_at", "reviewed_at")):
        return iso(now - timedelta(hours=(row_no * 3) % 72))
    if n in {"date", "business_date", "report_date"} or n.endswith("_date"):
        return (now.date() - timedelta(days=row_no % 30)).isoformat()
    if n == "username":
        return f"synthetic.user{row_no}"
    if "email" in n:
        return f"synthetic.user{row_no}@example.invalid"
    if any(x in n for x in ("phone", "mobile", "telephone")):
        return f"+234800000{row_no:04d}"
    if any(x in n for x in ("country", "jurisdiction", "residence")):
        return "NG"
    if n in {"currency", "currency_code", "settlement_currency", "fiat_currency"} or "currency" in n:
        return "NGN"
    if any(x in n for x in ("state", "region")):
        return ["Lagos", "Abuja Federal Capital Territory", "Rivers", "Kano"][row_no % 4]
    if "city" in n:
        return ["Lagos", "Abuja", "Port Harcourt", "Kano"][row_no % 4]
    if any(x in n for x in ("name", "full_name", "display_name")):
        if "company" in n or "entity" in n or "organisation" in n or "organization" in n:
            return ["Aso Digital Markets Ltd", "Lagos Settlement Services Ltd", "Niger Delta Payments Ltd"][row_no % 3]
        return ["Amina Bello", "Chinedu Okafor", "Fatima Ibrahim", "Tunde Adeyemi"][row_no % 4]
    if any(x in n for x in ("description", "summary", "notes", "reason", "comment")):
        return "Synthetic CBN Cohort 2 VASP scenario record; not real customer or regulatory evidence."
    if any(x in n for x in ("sha", "digest", "hash", "checksum")):
        return stable_hex(seed)
    if any(x in n for x in ("status", "state", "decision", "outcome")):
        choices = ["pending", "approved", "review_required", "reconciled", "closed"]
        return choices[row_no % len(choices)]
    if any(x in n for x in ("role", "type", "category", "track", "kind")):
        if "track" in n:
            return "VASP"
        if "role" in n:
            return ["compliance_mlro", "security", "operations", "auditor"][row_no % 4]
        return "synthetic"
    if any(x in n for x in ("subject", "actor", "owner", "reviewer")):
        return f"synthetic.subject.{row_no:03d}"
    if "file_bytes" in n or "max_bytes" in n:
        return 10485760
    if any(x in n for x in ("amount", "value", "limit", "balance", "fee", "volume")):
        return Decimal(str([125000, 250000, 500000, 1000000][row_no % 4]))
    if any(x in n for x in ("count", "quantity", "attempt", "priority", "score", "level")):
        return row_no + 1
    if any(x in n for x in ("enabled", "active", "verified", "approved", "passed", "is_")):
        return True
    if any(x in n for x in ("url", "uri", "link")):
        return "https://synthetic.umoja.invalid/evidence/" + stable_hex(seed, 16)
    if "json" in column.data_type or column.udt_name in ("json", "jsonb"):
        return {"scenario": SCENARIO_VERSION, "synthetic": True, "table": t, "row": row_no}
    if column.udt_name in ("uuid",):
        return stable_uuid(seed)
    if column.data_type in ("boolean",):
        return True
    if column.data_type in ("integer", "bigint", "smallint"):
        return row_no + 1
    if column.data_type in ("numeric", "decimal", "real", "double precision"):
        return Decimal(str(row_no + 1))
    if column.data_type in ("date",):
        return (now.date() - timedelta(days=row_no % 30)).isoformat()
    if "time" in column.data_type:
        return iso(now - timedelta(hours=row_no))
    if column.data_type in ("text", "character varying", "character", "citext"):
        return f"synthetic:{t}:{column.name}:{row_no}"
    if column.data_type.endswith("[]") or column.udt_name.startswith("_" ):
        return []
    return None


def synthetic_row(table: Table, row_no: int, now: datetime, enum_values: dict[str, tuple[str, ...]] | None = None, foreign_keys: dict[tuple[str, str, str], tuple[str, str, str]] | None = None, check_values: dict[tuple[str, str], tuple[str, ...]] | None = None) -> dict[str, Any]:
    row: dict[str, Any] = {}
    for col in table.columns:
        if not is_insertable(col) and not ((table.name == "control_evidence_outbox" and col.name == "payload") or (table.name == "treasury_rebalancing_recommendations" and col.name == "status")):
            continue
        if table.name == "external_stakeholder_assignments" and col.name in {"counterparty_id", "dossier_id"}:
            if col.name == "counterparty_id" and row_no == 2:
                row[col.name] = None
                continue
            if col.name == "dossier_id" and row_no == 1:
                row[col.name] = None
                continue
        if table.name == "aml_screening_checks" and col.name in {"customer_id", "payment_order_id"}:
            row[col.name] = None
            continue
        if table.name == "payment_orders" and col.name == "policy_decision_id":
            row[col.name] = None
            continue
        fk = (table.schema, table.name, col.name)
        if foreign_keys and fk in foreign_keys:
            parent_schema, parent_table, parent_column = foreign_keys[fk]
            if col.udt_name == "uuid":
                value = stable_uuid(f"{parent_schema}.{parent_table}.{parent_column}.{row_no}")
            elif parent_column in {"subject", "username", "operator_subject"}:
                value = f"synthetic.subject.{row_no:03d}"
            else:
                value = business_value(table, col, row_no, now, enum_values, check_values)
        else:
            value = business_value(table, col, row_no, now, enum_values, check_values)
        if value is None and not col.nullable:
            # A conservative fallback for required opaque scalar columns.
            if col.data_type in ("text", "character varying", "character", "citext"):
                value = f"synthetic-required:{table.name}:{col.name}:{row_no}"
            elif col.data_type == "boolean":
                value = False
            elif col.data_type in ("integer", "bigint", "smallint"):
                value = 0
            elif col.udt_name == "uuid":
                value = stable_uuid(f"{table.name}.{col.name}.{row_no}")
        if value is not None:
            row[col.name] = value
    return row


def load_enum_values(conn, schema: str) -> dict[str, tuple[str, ...]]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT t.typname, e.enumlabel
            FROM pg_type t
            JOIN pg_enum e ON e.enumtypid=t.oid
            JOIN pg_namespace n ON n.oid=t.typnamespace
            WHERE n.nspname=%s
            ORDER BY t.typname, e.enumsortorder
        """, (schema,))
        values: dict[str, list[str]] = {}
        for typname, label in cur.fetchall():
            values.setdefault(typname, []).append(label)
    return {name: tuple(labels) for name, labels in values.items()}


def load_check_values(conn, schema: str) -> dict[tuple[str, str], tuple[str, ...]]:
    values: dict[tuple[str, str], tuple[str, ...]] = {}
    with conn.cursor() as cur:
        cur.execute("""
            SELECT c.relname, pg_get_constraintdef(pc.oid)
            FROM pg_constraint pc
            JOIN pg_class c ON c.oid=pc.conrelid
            JOIN pg_namespace n ON n.oid=c.relnamespace
            WHERE n.nspname=%s AND pc.contype='c'
        """, (schema,))
        for table_name, definition in cur.fetchall():
            match = re.search(r"\(\(?(?P<column>[A-Za-z0-9_]+)\s*=\s*ANY\s*\(ARRAY\[(?P<array>[^]]+)\]", definition)
            if not match:
                continue
            column_name = match.group("column")
            labels = tuple(re.findall(r"'([^']+)'", match.group("array")))
            if labels:
                values[(table_name, column_name)] = labels
    return values


def load_foreign_keys(conn, schema: str) -> dict[tuple[str, str, str], tuple[str, str, str]]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT tc.table_schema, tc.table_name, kcu.column_name,
                   ccu.table_schema, ccu.table_name, ccu.column_name
            FROM information_schema.table_constraints tc
            JOIN information_schema.key_column_usage kcu
              ON tc.constraint_name=kcu.constraint_name AND tc.table_schema=kcu.table_schema
            JOIN information_schema.constraint_column_usage ccu
              ON ccu.constraint_name=tc.constraint_name AND ccu.constraint_schema=tc.constraint_schema
            WHERE tc.constraint_type='FOREIGN KEY' AND tc.table_schema=%s
            ORDER BY tc.table_name, kcu.ordinal_position
        """, (schema,))
        return {(r[0], r[1], r[2]): (r[3], r[4], r[5]) for r in cur.fetchall()}


def order_tables(tables: list[Table], foreign_keys: dict[tuple[str, str, str], tuple[str, str, str]]) -> list[Table]:
    by_key = {(t.schema, t.name): t for t in tables}
    dependencies = {key: set() for key in by_key}
    for child, parent in foreign_keys.items():
        if child == ("public", "payment_orders", "policy_decision_id"):
            # This nullable edge participates in a schema cycle with policy_decisions.
            # Seed the order first with NULL, then seed the required reverse edge.
            continue
        child_key = child[:2]
        parent_key = parent[:2]
        if child_key in dependencies and parent_key in by_key and child_key != parent_key:
            dependencies[child_key].add(parent_key)
    ordered: list[Table] = []
    remaining = set(dependencies)
    while remaining:
        ready = sorted(key for key in remaining if not (dependencies[key] & remaining))
        if not ready:
            # Cyclic/self-referential tables are placed last; PostgreSQL remains
            # authoritative and any unsatisfied cycle fails closed on apply.
            ready = sorted(remaining)
        for key in ready:
            ordered.append(by_key[key])
            remaining.remove(key)
    return ordered


def load_tables(conn, schema: str) -> list[Table]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
                   c.udt_name, c.is_nullable, c.column_default,
                   c.is_identity, c.is_generated, c.ordinal_position
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema=c.table_schema AND t.table_name=c.table_name
            WHERE c.table_schema=%s
              AND t.table_type='BASE TABLE'
              AND c.table_name NOT IN ('schema_migrations')
            ORDER BY c.table_schema, c.table_name, c.ordinal_position
        """, (schema,))
        grouped: dict[tuple[str, str], list[Column]] = {}
        for r in cur.fetchall():
            key = (r[0], r[1])
            grouped.setdefault(key, []).append(Column(r[2], r[3], r[4], r[5] == "YES", r[6], r[7] == "YES", r[8] == "ALWAYS", r[9]))
    return [Table(s, n, tuple(cols)) for (s, n), cols in grouped.items()]


def json_safe(value: Any) -> Any:
    if isinstance(value, Decimal):
        return str(value)
    return value


def write_manifest(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, default=json_safe) + "\n", encoding="utf-8")


def build_sql(table: Table, row: dict[str, Any]) -> tuple[str, list[Any]]:
    from psycopg.types.json import Jsonb
    names = list(row)
    cols = ", ".join(quote_ident(x) for x in names)
    placeholders = ", ".join(["%s"] * len(names))
    sql = f"INSERT INTO {quote_ident(table.schema)}.{quote_ident(table.name)} ({cols}) VALUES ({placeholders}) ON CONFLICT DO NOTHING"
    params: list[Any] = []
    by_name = {c.name: c for c in table.columns}
    for name in names:
        value = row[name]
        if by_name[name].udt_name in ("json", "jsonb") and isinstance(value, (dict, list)):
            value = Jsonb(value)
        params.append(value)
    return sql, params


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--database-url", default=os.getenv("DATABASE_URL"), help="PostgreSQL URL; never use a production URL")
    ap.add_argument("--environment", default=os.getenv("APP_ENV", "local"))
    ap.add_argument("--schema", default="public")
    ap.add_argument("--rows-per-table", type=int, default=3)
    ap.add_argument("--manifest", type=Path, default=Path("artifacts/synthetic_nigeria_seed_manifest.json"))
    ap.add_argument("--dry-run", action="store_true", help="Inspect schema and write planned rows without database writes")
    ap.add_argument("--apply", action="store_true", help="Write rows; requires --database-url and a non-production environment")
    ap.add_argument("--truncate", action="store_true", help="Not supported; explicit deletion is intentionally refused")
    args = ap.parse_args()
    if args.truncate:
        print("refusing --truncate: use a disposable database and explicit migration reset tooling", file=sys.stderr)
        return 2
    if args.environment.lower() in FORBIDDEN_ENVIRONMENTS:
        print("refusing to seed a production/live environment", file=sys.stderr)
        return 2
    if not args.dry_run and not args.apply:
        print("choose exactly one of --dry-run or --apply", file=sys.stderr)
        return 2
    if args.rows_per_table < 1 or args.rows_per_table > 1000:
        print("--rows-per-table must be between 1 and 1000", file=sys.stderr)
        return 2
    try:
        import psycopg
    except ImportError:
        if args.dry_run:
            print("psycopg is required even for dry-run because schema introspection is database-backed", file=sys.stderr)
            return 2
        print("install psycopg with the repository's approved dependency process", file=sys.stderr)
        return 2
    if not args.database_url:
        print("--database-url or DATABASE_URL is required", file=sys.stderr)
        return 2
    now = datetime.now(timezone.utc)
    manifest: dict[str, Any] = {"scenario_version": SCENARIO_VERSION, "synthetic": True, "environment": args.environment, "schema": args.schema, "generated_at": iso(now), "tables": []}
    with psycopg.connect(args.database_url, connect_timeout=10) as conn:
        tables = load_tables(conn, args.schema)
        enum_values = load_enum_values(conn, args.schema)
        foreign_keys = load_foreign_keys(conn, args.schema)
        check_values = load_check_values(conn, args.schema)
        tables = order_tables(tables, foreign_keys)
        for table in tables:
            rows = [synthetic_row(table, i, now, enum_values, foreign_keys, check_values) for i in range(1, args.rows_per_table + 1)]
            rows = [r for r in rows if r]
            item = {"table": f"{table.schema}.{table.name}", "row_count": len(rows), "rows": rows}
            manifest["tables"].append(item)
            if args.apply:
                with conn.transaction():
                    with conn.cursor() as cur:
                        for row in rows:
                            sql, params = build_sql(table, row)
                            try:
                                cur.execute(sql, params)
                            except Exception as exc:
                                raise RuntimeError(f"seed failed for {table.schema}.{table.name}: {exc}") from exc
    write_manifest(args.manifest, manifest)
    print(json.dumps({"status": "planned" if args.dry_run else "applied", "synthetic": True, "table_count": len(manifest["tables"]), "manifest": str(args.manifest)}, indent=2))
    return 0

if __name__ == "__main__":
    raise SystemExit(main())

# End of file

# This script intentionally requires a database-backed schema introspection step.
# It does not fabricate regulatory evidence, customer identity, UBOs, sanctions
# results, or production financial facts. All generated values are synthetic.

# Additional deterministic business scenario anchors are encoded through the
# Nigeria-specific values above: NG jurisdiction, NGN currency, Nigerian cities,
# bounded transaction amounts, VASP track, and synthetic CBN Cohort 2 labels.

# The table surface is discovered at runtime, so future migrations are included
# automatically without requiring a hand-maintained table allow-list.

# A future production seeding workflow must remain separate from this engine and
# must use approved, privacy-preserving fixtures instead of real records.

# No external network, cloud vendor, or Manus-specific dependency is used.

# PostgreSQL is the only supported persistence target.

# End-to-end tests should run against a disposable PostgreSQL database.

# The manifest is suitable for local review and test evidence only.

# Do not use it as CBN evidence.

# Final guard: explicit environment refusal above remains authoritative.

# End.
