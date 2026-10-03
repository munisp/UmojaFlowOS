-- 0067: durable idempotency records for multirail payment submissions.
-- Replaces the in-memory Map in apps/control-plane/server/multiRailFailover.ts.
CREATE TABLE IF NOT EXISTS multirail_submission_records (
  idempotency_key text PRIMARY KEY,
  intent_id text NOT NULL,
  rail text NOT NULL,
  status text NOT NULL CHECK (status IN ('submitted','pending','settled','failed','held','unknown')),
  provider_ref text,
  safe_to_retry boolean,
  created_at timestamptz NOT NULL DEFAULT now()
);
