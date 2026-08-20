DO $$ BEGIN
  CREATE TYPE super_administrator_assignment_status AS ENUM ('active', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE super_administrator_assignments (
  subject TEXT PRIMARY KEY CHECK (char_length(subject) BETWEEN 3 AND 256),
  status super_administrator_assignment_status NOT NULL DEFAULT 'active',
  assigned_by TEXT,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  revoked_by TEXT,
  revoked_at TIMESTAMPTZ,
  revocation_reason TEXT,
  CHECK (
    (status = 'active' AND revoked_by IS NULL AND revoked_at IS NULL AND revocation_reason IS NULL)
    OR
    (status = 'revoked' AND revoked_by IS NOT NULL AND revoked_at IS NOT NULL AND char_length(trim(revocation_reason)) >= 16)
  )
);

CREATE TABLE administrator_approval_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'suspended', 'revoked')),
  decided_by TEXT NOT NULL REFERENCES super_administrator_assignments(subject),
  rationale TEXT NOT NULL CHECK (char_length(trim(rationale)) BETWEEN 16 AND 4000),
  decided_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (administrator_account_id, decision, decided_at)
);

CREATE INDEX administrator_approval_decisions_account_idx
  ON administrator_approval_decisions (administrator_account_id, decided_at DESC);
