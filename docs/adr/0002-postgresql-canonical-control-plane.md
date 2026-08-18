# ADR 0002: PostgreSQL is the canonical UmojaFlowOS control-plane database

## Status

**Accepted.** PostgreSQL is mandatory for every production control-plane deployment. The managed MySQL/TiDB application database is a transitional development artifact and must not receive further canonical schema changes.

## Decision

The canonical deployment uses PostgreSQL with UUID primary keys, `timestamptz` timestamps, `jsonb` evidence payloads, transactional migrations, and explicit relational constraints. The PostgreSQL migrations under `database/postgresql/` are the only source of truth for the production data model. The TypeScript service will be ported to a PostgreSQL-compatible access layer; the Go payment engine, Rust risk and ledger services, and Python reporting service retain language-specific ownership but exchange UUID-based, versioned contracts.

## Cutover boundary

The transitional database assessment on 2026-08-18 found one authenticated user and zero business records across counterparties, authorisations, customers, beneficiaries, payments, payment legs, liquidity positions, market observations, compliance cases, reports, deadlines, alerts, and activity events. Consequently, no fabricated or synthetic business data is needed for the PostgreSQL cutover. Before any future cutover, the migration process must take a read-only source snapshot, verify row counts and checksums per table, load only approved records, verify destination counts and checksums, and retain the source snapshot until reconciliation is signed off.

## Consequences

The managed WebDev MySQL database cannot be the final production store. A PostgreSQL environment must be provisioned before the control plane is switched. PostgreSQL schema migration, data reconciliation, and service health verification are hard release gates. Payment execution, KYC/sanctions results, market observations, notifications, and regulatory submission remain inactive until their approved providers are separately configured and verified.
