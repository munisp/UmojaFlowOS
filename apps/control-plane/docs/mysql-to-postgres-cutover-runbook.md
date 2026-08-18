# MySQL/TiDB to PostgreSQL Cutover Runbook

PostgreSQL is UmojaFlowOS's canonical control-plane store. The legacy MySQL/TiDB schema is transitional only. The executable tooling has deterministic, reconciled mappings for active user-role assignments, counterparties, counterparty authorisations, integration connections, market observations, customers, beneficiaries, payment-order metadata, payment legs, and rate locks. Payment orders with a legacy policy-decision reference are rejected because no canonical policy-decision mapping has been approved. The tooling does not transfer balances, KYC documents, screening results, cases, reports, or provider outcomes without a separately reviewed table mapping and reconciliation contract.

| Stage | Command | Required outcome | Fail-closed condition |
|---|---|---|---|
| Read-only preflight | `pnpm postgres:cutover-preflight` | Emits `sourceSnapshotSha256`, source counts, mapped-role count, and target status | Invalid role, missing source URL, incomplete PostgreSQL schema |
| Dry run | `MIGRATION_DRY_RUN=1 pnpm postgres:migrate-transition` | Computes source/destination role checksums without writes | Non-empty business tables or mismatched role mapping |
| Apply | `MIGRATION_EXECUTION_APPROVED=1 MIGRATION_INITIATED_BY=<subject> MIGRATION_APPROVED_SOURCE_SNAPSHOT_SHA256=<hash> pnpm postgres:migrate-transition` | Writes supported user-role, counterparty, and customer mappings plus immutable evidence | Missing approval, operator attribution, snapshot drift, checksum mismatch, unsupported table, or unsupported counterparty type |

`postgres_cutover_runs` records snapshot, responsible subject, and run status. `postgres_cutover_table_reconciliations` records source and destination counts and checksums for every table actually migrated. A successful local role cutover is not production activation; protected PostgreSQL connectivity, immutable source retention, independent reconciliation sign-off, and service/provider activation checks remain separate gates.
