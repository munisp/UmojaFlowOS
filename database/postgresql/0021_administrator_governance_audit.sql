CREATE TABLE administrator_governance_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  administrator_account_id UUID NOT NULL REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  actor_subject TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('enrollment_requested', 'approval_granted', 'approval_rejected', 'access_suspended', 'access_revoked', 'access_reinstated', 'handover_recorded', 'super_administrator_assigned', 'super_administrator_revoked')),
  reason TEXT NOT NULL CHECK (char_length(trim(reason)) BETWEEN 8 AND 4000),
  handover_to_administrator_account_id UUID REFERENCES stakeholder_accounts(id) ON DELETE RESTRICT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX administrator_governance_audit_account_idx
  ON administrator_governance_audit (administrator_account_id, occurred_at DESC);

CREATE OR REPLACE FUNCTION enforce_administrator_governance_audit()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.requested_role = 'admin'::operating_role AND NEW.status = 'active'::stakeholder_account_status THEN
    IF NOT EXISTS (
      SELECT 1
      FROM administrator_approval_decisions decision
      JOIN super_administrator_assignments super_admin ON super_admin.subject = decision.decided_by
      WHERE decision.administrator_account_id = NEW.id
        AND decision.decision = 'approved'
        AND super_admin.status = 'active'
    ) THEN
      RAISE EXCEPTION 'administrator activation requires an active super-administrator approval decision';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS enforce_administrator_governance_audit ON stakeholder_accounts;
CREATE TRIGGER enforce_administrator_governance_audit
BEFORE INSERT OR UPDATE OF status ON stakeholder_accounts
FOR EACH ROW EXECUTE FUNCTION enforce_administrator_governance_audit();
