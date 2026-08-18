# MySQL/TiDB to PostgreSQL Cutover Runbook

## Scope and non-negotiable boundary

PostgreSQL is UmojaFlowOS's canonical control-plane store. The legacy MySQL/TiDB schema is transitional only. The executable tooling has deterministic, reconciled mappings for active user-role assignments, counterparties, counterparty authorisations, integration connections, customers, beneficiaries, and payment-order metadata. Payment orders with a legacy policy-decision reference are rejected because no canonical policy-decision mapping has been approved. The tooling **does not** transfer payment legs, balances, KYC documents, rates, screening results, cases, reports, or provider outcomes without a separately reviewed table mapping and destination reconciliation contract.

| Cutover stage | Command | Required outcome | Fail-closed condition |
|---|---|---|---|
| Read-only preflight | `pnpm postgres:cutover-preflight` | Emits `sourceSnapshotSha256`, source table counts, mapped-role count, and target schema status | Invalid role, missing source URL, incomplete PostgreSQL schema |
| Approval | Operator records the exact snapshot SHA-256 and accountable subject | Snapshot represents the approved source state | Any source change changes the snapshot hash |
| Dry run | `MIGRATION_DRY_RUN=1 pnpm postgres:migrate-transition` | Computes source/destination role count and checksum without writes | Non-empty business tables; mismatched role mapping |
| Apply | `MIGRATION_EXECUTION_APPROVED=1 MIGRATION_INITIATED_BY=<subject> MIGRATION_APPROVED_SOURCE_SNAPSHOT_SHA256=<hash> pnpm postgres:migrate-transition` | Writes supported user-role, counterparty, and customer mappings plus immutable run/reconciliation evidence | Missing explicit approval, missing operator attribution, snapshot drift, checksum mismatch, unsupported table, or unsupported counterparty type |
| Sign-off | Query `postgres_cutover_runs` and `postgres_cutover_table_reconciliations` | Run status is `verified`; each migrated table count and checksum agrees | Missing evidence, any mismatch, or unverified run |

## Deterministic identity and role mapping

The migration reads `users.openId` and `users.role` from the transitional schema. It accepts only `admin`, `compliance_officer`, `treasury_operator`, and `auditor`, then writes equivalent active `user_role_assignments` records to PostgreSQL. Any other role blocks the run before target mutation.

For future approved business-table mappings, the cutover helper provides deterministic UUIDv5-shaped identifiers derived from the source table and source primary key. This preserves repeatability and cross-table references without using a mutable mapping spreadsheet. A new non-empty table must not be enabled until its source projection, target insert, foreign-key ordering, source and destination normalizers, count check, and SHA-256 reconciliation check have each been reviewed and tested.

## Reconciliation evidence

`postgres_cutover_runs` stores the approved source snapshot hash, an irreversibly redacted source database fingerprint, responsible operator subject, mode, timing, and terminal status. `postgres_cutover_table_reconciliations` stores the source and destination counts and checksums for every table actually migrated. The process rolls back all target changes if a checksum diverges.

> The migration program deliberately does not treat a successful local development run as production cutover. Production activation still requires a protected PostgreSQL URI, immutable source snapshot retention, approved business-table mappings where applicable, independent reconciliation sign-off, service health validation, and provider activation gates.
