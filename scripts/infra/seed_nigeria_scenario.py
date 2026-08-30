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
    if column.default and any(x in column.default.lower() for x in ("nextval(", "gen_random_uuid", "uuid_generate", "current_timestamp", "now()")):
        return False
    return True


def business_value(table: Table, column: Column, row_no: int, now: datetime) -> Any:
    n = column.name.lower()
    t = table.name.lower()
    seed = f"{table.schema}.{table.name}.{column.name}.{row_no}"
    if n in {"id", "uuid", "record_id", "event_id", "case_id", "customer_id", "account_id", "order_id", "run_id", "request_id", "evidence_id", "document_id"} or n.endswith("_id"):
        return stable_uuid(seed)
    if any(x in n for x in ("created_at", "updated_at", "occurred_at", "submitted_at", "approved_at", "effective_at", "observed_at", "received_at", "started_at", "completed_at", "resolved_at", "reviewed_at")):
        return iso(now - timedelta(hours=(row_no * 3) % 72))
    if n in {"date", "business_date", "report_date"} or n.endswith("_date"):
        return (now.date() - timedelta(days=row_no % 30)).isoformat()
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
    if any(x in n for x in ("sha", "digest", "hash")):
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


def synthetic_row(table: Table, row_no: int, now: datetime) -> dict[str, Any]:
    row: dict[str, Any] = {}
    for col in table.columns:
        if not is_insertable(col):
            continue
        value = business_value(table, col, row_no, now)
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


def load_tables(conn, schema: str) -> list[Table]:
    with conn.cursor() as cur:
        cur.execute("""
            SELECT c.table_schema, c.table_name, c.column_name, c.data_type,
                   c.udt_name, c.is_nullable, c.column_default,
                   c.is_identity, c.is_generated, c.ordinal_position
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_schema=c.table_schema AND t.table_name=c.table_name
            WHERE c.table_schema=%s AND t.table_type='BASE TABLE'
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
    names = list(row)
    cols = ", ".join(quote_ident(x) for x in names)
    placeholders = ", ".join(["%s"] * len(names))
    sql = f"INSERT INTO {quote_ident(table.schema)}.{quote_ident(table.name)} ({cols}) VALUES ({placeholders})"
    return sql, [row[x] for x in names]


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
        for table in tables:
            rows = [synthetic_row(table, i, now) for i in range(1, args.rows_per_table + 1)]
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
