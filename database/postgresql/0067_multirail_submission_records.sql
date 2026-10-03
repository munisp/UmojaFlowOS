-- 0067: Durable multi-rail submission records.
--
-- The multi-rail failover coordinators (TypeScript control plane and Rust
-- ledger-gateway library) previously held their idempotency records only in
-- process memory. A restart between a provider submit and a client retry could
-- therefore lose the recorded rail/outcome and risk a duplicate submission.
-- This table is the canonical record; in-memory maps are demoted to
-- test/dev-only fast paths.
CREATE TABLE IF NOT EXISTS multirail_submission_records (
  idempotency_key  text PRIMARY KEY,
  intent_id        text NOT NULL,
  rail             text NOT NULL,
  status           text NOT NULL CHECK (status IN ('submitted','pending','settled','failed','held','unknown')),
  provider_ref     text,
  safe_to_retry    boolean,
  created_at       timestamptz NOT NULL DEFAULT now()
);
-- Lookups are by primary key only; no secondary index is justified.
