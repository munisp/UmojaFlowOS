ALTER TYPE operating_role ADD VALUE IF NOT EXISTS 'provider_contact';
ALTER TYPE operating_role ADD VALUE IF NOT EXISTS 'cbn_liaison';

CREATE TYPE external_stakeholder_assignment_status AS ENUM ('assigned', 'suspended');
CREATE TYPE external_stakeholder_evidence_category AS ENUM (
  'provider_licensing',
  'product_entitlement',
  'technical_endpoint',
  'callback_configuration',
  'operating_runbook',
  'application_correspondence',
  'review_request',
  'review_response'
);

CREATE TABLE operator_role_assignments (
  subject TEXT PRIMARY KEY,
  role operating_role NOT NULL CHECK (role IN ('provider_contact', 'cbn_liaison')),
  status external_stakeholder_assignment_status NOT NULL DEFAULT 'assigned',
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at TIMESTAMPTZ
);

CREATE TABLE external_stakeholder_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stakeholder_role operating_role NOT NULL CHECK (stakeholder_role IN ('provider_contact', 'cbn_liaison')),
  stakeholder_subject TEXT NOT NULL REFERENCES operator_role_assignments(subject),
  counterparty_id UUID REFERENCES counterparties(id),
  dossier_id UUID REFERENCES cbn_sandbox_dossiers(id),
  status external_stakeholder_assignment_status NOT NULL DEFAULT 'assigned',
  assigned_by TEXT NOT NULL,
  assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  suspended_at TIMESTAMPTZ,
  CHECK (
    (stakeholder_role = 'provider_contact' AND counterparty_id IS NOT NULL AND dossier_id IS NULL)
    OR
    (stakeholder_role = 'cbn_liaison' AND dossier_id IS NOT NULL AND counterparty_id IS NULL)
  ),
  UNIQUE (stakeholder_role, stakeholder_subject, counterparty_id, dossier_id)
);

CREATE TABLE external_stakeholder_evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id UUID NOT NULL REFERENCES external_stakeholder_assignments(id),
  category external_stakeholder_evidence_category NOT NULL,
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (assignment_id, category, evidence_sha256)
);

CREATE INDEX external_stakeholder_assignments_subject_idx
  ON external_stakeholder_assignments (stakeholder_subject, status, assigned_at DESC);
CREATE INDEX external_stakeholder_evidence_assignment_idx
  ON external_stakeholder_evidence (assignment_id, recorded_at DESC);
