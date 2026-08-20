CREATE TABLE stakeholder_account_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stakeholder_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE CASCADE,
  token_sha256 CHAR(64) NOT NULL UNIQUE CHECK (token_sha256 ~ '^[0-9a-f]{64}$'),
  issued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  revoked_at TIMESTAMPTZ,
  revoked_reason TEXT,
  CHECK (expires_at > issued_at),
  CHECK ((revoked_at IS NULL AND revoked_reason IS NULL) OR (revoked_at IS NOT NULL AND char_length(trim(revoked_reason)) >= 8))
);
CREATE INDEX stakeholder_account_sessions_active_idx
  ON stakeholder_account_sessions (stakeholder_account_id, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE stakeholder_notification_preferences (
  stakeholder_account_id UUID PRIMARY KEY REFERENCES stakeholder_accounts(id) ON DELETE CASCADE,
  email_kyc_reminders_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  updated_by TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE stakeholder_account_security_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stakeholder_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  message_type TEXT NOT NULL CHECK (message_type IN ('account_approved', 'account_suspended', 'account_revoked', 'kyc_approved', 'kyc_rejected', 'kyc_action_required')),
  message_state TEXT NOT NULL DEFAULT 'pending' CHECK (message_state IN ('pending', 'delivered', 'failed')),
  message_hash CHAR(64) NOT NULL CHECK (message_hash ~ '^[0-9a-f]{64}$'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  delivered_at TIMESTAMPTZ,
  UNIQUE (stakeholder_account_id, message_type, message_hash)
);
CREATE INDEX stakeholder_account_security_messages_account_idx
  ON stakeholder_account_security_messages (stakeholder_account_id, created_at DESC);
