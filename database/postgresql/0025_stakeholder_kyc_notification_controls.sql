ALTER TABLE stakeholder_accounts
  ADD COLUMN IF NOT EXISTS notification_email TEXT;
ALTER TABLE stakeholder_accounts
  ADD CONSTRAINT stakeholder_accounts_notification_email_check
  CHECK (notification_email IS NULL OR notification_email ~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$');

CREATE TABLE stakeholder_kyc_reminder_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_request_id UUID NOT NULL REFERENCES administrator_kyc_evidence_requests(id) ON DELETE RESTRICT,
  stakeholder_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  channel TEXT NOT NULL CHECK (channel IN ('in_platform', 'email')),
  delivery_state TEXT NOT NULL DEFAULT 'queued' CHECK (delivery_state IN ('queued', 'delivered', 'failed', 'not_configured')),
  privacy_safe_message_hash CHAR(64) NOT NULL CHECK (privacy_safe_message_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  UNIQUE (evidence_request_id, channel, privacy_safe_message_hash)
);
CREATE INDEX stakeholder_kyc_reminder_deliveries_account_idx
  ON stakeholder_kyc_reminder_deliveries (stakeholder_account_id, created_at DESC);
