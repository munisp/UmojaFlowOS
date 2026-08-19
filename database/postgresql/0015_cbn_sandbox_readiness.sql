CREATE TYPE cbn_sandbox_track AS ENUM ('vasp', 'data_enabled_non_vasp');
CREATE TYPE cbn_sandbox_dossier_status AS ENUM ('draft', 'ready_for_external_submission', 'external_submission_pending');
CREATE TYPE cbn_sandbox_evidence_category AS ENUM ('corporate_governance', 'ownership', 'financial_capacity', 'aml_cft_cpf', 'consumer_protection', 'cybersecurity', 'data_protection', 'operational_resilience', 'business_continuity', 'stablecoin_governance', 'reserve_attestation', 'redemption', 'custody_key_management', 'third_party_oversight', 'testing_plan');
CREATE TYPE cbn_sandbox_plan_status AS ENUM ('draft', 'documented', 'paused', 'ended');
CREATE TYPE cbn_sandbox_incident_kind AS ENUM ('cybersecurity', 'fraud', 'consumer_harm', 'operational_resilience');
CREATE TYPE cbn_sandbox_notification_status AS ENUM ('not_submitted', 'pending_authorised_channel', 'submitted');

CREATE TABLE cbn_sandbox_dossiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_entity_id UUID NOT NULL REFERENCES legal_entities(id),
  track cbn_sandbox_track NOT NULL,
  product_name TEXT NOT NULL CHECK (char_length(product_name) BETWEEN 3 AND 255),
  product_summary TEXT NOT NULL CHECK (char_length(product_summary) BETWEEN 50 AND 4000),
  status cbn_sandbox_dossier_status NOT NULL DEFAULT 'draft',
  external_submission_reference TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (legal_entity_id, track),
  CHECK ((status <> 'external_submission_pending' AND external_submission_reference IS NULL) OR (status = 'external_submission_pending' AND external_submission_reference IS NOT NULL))
);

CREATE TABLE cbn_sandbox_evidence_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES cbn_sandbox_dossiers(id),
  category cbn_sandbox_evidence_category NOT NULL,
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 CHAR(64) NOT NULL CHECK (evidence_sha256 ~ '^[0-9a-f]{64}$'),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (dossier_id, category, evidence_sha256)
);

CREATE TABLE cbn_sandbox_test_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL UNIQUE REFERENCES cbn_sandbox_dossiers(id),
  status cbn_sandbox_plan_status NOT NULL DEFAULT 'draft',
  permitted_use TEXT NOT NULL CHECK (char_length(permitted_use) BETWEEN 20 AND 1000),
  user_category TEXT NOT NULL CHECK (char_length(user_category) BETWEEN 3 AND 255),
  max_transactions INTEGER NOT NULL CHECK (max_transactions > 0),
  max_aggregate_exposure NUMERIC(30,12) NOT NULL CHECK (max_aggregate_exposure > 0),
  starts_at TIMESTAMPTZ NOT NULL,
  ends_at TIMESTAMPTZ NOT NULL,
  success_metrics_uri TEXT NOT NULL CHECK (success_metrics_uri ~ '^https://'),
  wind_down_uri TEXT NOT NULL CHECK (wind_down_uri ~ '^https://'),
  documented_by TEXT NOT NULL,
  documented_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ends_at > starts_at)
);

CREATE TABLE cbn_sandbox_consumer_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES cbn_sandbox_dossiers(id),
  customer_id UUID NOT NULL REFERENCES customers(id),
  record_kind TEXT NOT NULL CHECK (record_kind IN ('disclosure_acceptance', 'complaint')),
  disclosure_version TEXT,
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  details TEXT NOT NULL CHECK (char_length(details) BETWEEN 10 AND 4000),
  status TEXT NOT NULL CHECK (status IN ('recorded', 'under_review', 'resolved')),
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_by TEXT,
  resolved_at TIMESTAMPTZ,
  resolution TEXT,
  CHECK ((record_kind = 'disclosure_acceptance' AND disclosure_version IS NOT NULL AND status = 'recorded') OR record_kind = 'complaint'),
  CHECK ((status <> 'resolved') OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL AND resolution IS NOT NULL))
);

CREATE TABLE cbn_sandbox_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES cbn_sandbox_dossiers(id),
  kind cbn_sandbox_incident_kind NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  occurred_at TIMESTAMPTZ NOT NULL,
  detected_at TIMESTAMPTZ NOT NULL,
  evidence_uri TEXT NOT NULL CHECK (evidence_uri ~ '^https://'),
  summary TEXT NOT NULL CHECK (char_length(summary) BETWEEN 20 AND 4000),
  notification_status cbn_sandbox_notification_status NOT NULL DEFAULT 'not_submitted',
  submission_reference TEXT,
  recorded_by TEXT NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (detected_at >= occurred_at),
  CHECK ((notification_status <> 'submitted' AND submission_reference IS NULL) OR (notification_status = 'submitted' AND submission_reference IS NOT NULL))
);

CREATE TABLE cbn_sandbox_reporting_packs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  dossier_id UUID NOT NULL REFERENCES cbn_sandbox_dossiers(id),
  period_start TIMESTAMPTZ NOT NULL,
  period_end TIMESTAMPTZ NOT NULL,
  artifact_uri TEXT NOT NULL CHECK (artifact_uri ~ '^https://'),
  artifact_sha256 CHAR(64) NOT NULL CHECK (artifact_sha256 ~ '^[0-9a-f]{64}$'),
  submission_status cbn_sandbox_notification_status NOT NULL DEFAULT 'not_submitted',
  submission_reference TEXT,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end > period_start),
  CHECK ((submission_status <> 'submitted' AND submission_reference IS NULL) OR (submission_status = 'submitted' AND submission_reference IS NOT NULL)),
  UNIQUE (dossier_id, period_start, period_end)
);

CREATE INDEX cbn_sandbox_evidence_dossier_idx ON cbn_sandbox_evidence_items (dossier_id, category, recorded_at DESC);
CREATE INDEX cbn_sandbox_incidents_dossier_idx ON cbn_sandbox_incidents (dossier_id, occurred_at DESC);
CREATE INDEX cbn_sandbox_consumer_records_dossier_idx ON cbn_sandbox_consumer_records (dossier_id, record_kind, recorded_at DESC);
