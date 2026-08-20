ALTER TYPE operating_role ADD VALUE IF NOT EXISTS 'corporate_trade_sponsor';
ALTER TYPE operating_role ADD VALUE IF NOT EXISTS 'procurement_owner';
ALTER TYPE operating_role ADD VALUE IF NOT EXISTS 'trade_finance_operator';
ALTER TYPE operating_role ADD VALUE IF NOT EXISTS 'supplier_representative';
ALTER TYPE operating_role ADD VALUE IF NOT EXISTS 'authorised_dealer_liaison';
ALTER TYPE operating_role ADD VALUE IF NOT EXISTS 'reconciliation_reviewer';

ALTER TABLE operator_role_assignments DROP CONSTRAINT IF EXISTS operator_role_assignments_role_check;
ALTER TABLE operator_role_assignments
  ADD CONSTRAINT operator_role_assignments_role_check CHECK (role IN (
    'provider_contact', 'cbn_liaison',
    'corporate_trade_sponsor', 'procurement_owner', 'trade_finance_operator',
    'supplier_representative', 'authorised_dealer_liaison', 'reconciliation_reviewer'
  ));

COMMENT ON CONSTRAINT operator_role_assignments_role_check ON operator_role_assignments IS
  'Trade stakeholder assignments grant only role-scoped control-record access. They do not grant financing, FX, custody, stablecoin transfer, payment, settlement, or regulatory-submission authority.';
