BEGIN;

CREATE TABLE postgres_cutover_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    source_snapshot_sha256 TEXT NOT NULL CHECK (source_snapshot_sha256 ~ '^[a-f0-9]{64}$'),
    source_database_fingerprint TEXT NOT NULL CHECK (length(trim(source_database_fingerprint)) > 0),
    mode TEXT NOT NULL CHECK (mode IN ('dry_run', 'apply')),
    initiated_by TEXT NOT NULL CHECK (length(trim(initiated_by)) > 0),
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL CHECK (status IN ('running', 'verified', 'failed')),
    failure_reason TEXT
);

CREATE TABLE postgres_cutover_table_reconciliations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cutover_run_id UUID NOT NULL REFERENCES postgres_cutover_runs(id),
    source_table TEXT NOT NULL,
    destination_table TEXT NOT NULL,
    source_count BIGINT NOT NULL CHECK (source_count >= 0),
    destination_count BIGINT NOT NULL CHECK (destination_count >= 0),
    source_checksum TEXT NOT NULL CHECK (source_checksum ~ '^[a-f0-9]{64}$'),
    destination_checksum TEXT NOT NULL CHECK (destination_checksum ~ '^[a-f0-9]{64}$'),
    status TEXT NOT NULL CHECK (status IN ('verified', 'mismatch')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (cutover_run_id, source_table, destination_table)
);

CREATE INDEX postgres_cutover_table_reconciliations_run_idx
  ON postgres_cutover_table_reconciliations (cutover_run_id, status);

COMMIT;
