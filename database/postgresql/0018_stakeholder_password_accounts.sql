DO $$ BEGIN
  CREATE TYPE stakeholder_account_status AS ENUM ('pending_approval', 'active', 'suspended');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE TABLE stakeholder_accounts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  username TEXT NOT NULL CHECK (username ~ '^[a-z][a-z0-9_.-]{2,63}$'),
  display_name TEXT NOT NULL CHECK (char_length(display_name) BETWEEN 2 AND 120),
  password_scrypt TEXT NOT NULL,
  requested_role operating_role NOT NULL,
  status stakeholder_account_status NOT NULL DEFAULT 'pending_approval',
  approved_by TEXT,
  approved_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_signed_in_at TIMESTAMPTZ,
  CHECK ((status = 'active' AND approved_by IS NOT NULL AND approved_at IS NOT NULL) OR status <> 'active')
);
CREATE UNIQUE INDEX stakeholder_accounts_username_lower_idx ON stakeholder_accounts (lower(username));
CREATE INDEX stakeholder_accounts_review_idx ON stakeholder_accounts (status, created_at);
