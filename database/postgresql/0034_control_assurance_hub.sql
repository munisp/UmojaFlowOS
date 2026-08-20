-- Provider-independent Control Assurance Hub.
-- Records assurance facts and generated packet references only. It cannot activate,
-- instruct, fund, transfer, issue, settle, submit, or represent external authority.

CREATE TYPE assurance_outcome AS ENUM ('covered', 'attention_required', 'blocked', 'unavailable');
CREATE TYPE adapter_certification_state AS ENUM ('documented', 'evidence_pending', 'ready_for_controlled_test', 'blocked', 'retired');

CREATE TABLE IF NOT EXISTS control_assurance_assessments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assessment_kind text NOT NULL CHECK (assessment_kind IN ('control_coverage','separation_of_duties','evidence_freshness','counterparty_route_readiness','reconciliation_completeness','stablecoin_policy_coverage','adapter_certification')),
  subject_type text NOT NULL,
  subject_id text NOT NULL,
  outcome assurance_outcome NOT NULL,
  finding_codes jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(finding_codes) = 'array'),
  evidence_uri text NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 char(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  external_execution_initiated boolean NOT NULL DEFAULT false CHECK (external_execution_initiated = false),
  authoritative_for_execution boolean NOT NULL DEFAULT false CHECK (authoritative_for_execution = false),
  assessed_by text NOT NULL,
  assessed_role operating_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS adapter_certification_evidence (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  counterparty_id uuid NOT NULL REFERENCES counterparties(id),
  integration_connection_id uuid REFERENCES integration_connections(id),
  adapter_kind text NOT NULL CHECK (adapter_kind IN ('bank_treasury','stablecoin_execution','trade_finance','spend_card','payment_network','reconciliation')),
  certification_state adapter_certification_state NOT NULL DEFAULT 'documented',
  corridor corridor_code,
  asset text CHECK (asset IS NULL OR asset IN ('USDC','USDT','NGN','KES','ZAR','USD')),
  evidence_uri text NOT NULL CHECK (evidence_uri ~ '^https://'),
  evidence_sha256 char(64) NOT NULL CHECK (evidence_sha256 ~ '^[a-f0-9]{64}$'),
  controlled_test_reference text,
  external_execution_initiated boolean NOT NULL DEFAULT false CHECK (external_execution_initiated = false),
  certified_by text NOT NULL,
  certified_role operating_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS control_audit_packets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  packet_scope text NOT NULL CHECK (packet_scope IN ('trade_case','enterprise_module','counterparty_adapter','corridor','stablecoin_treasury')),
  scope_reference text NOT NULL,
  packet_uri text NOT NULL CHECK (packet_uri ~ '^https://'),
  packet_sha256 char(64) NOT NULL CHECK (packet_sha256 ~ '^[a-f0-9]{64}$'),
  evidence_count integer NOT NULL CHECK (evidence_count >= 0),
  external_execution_initiated boolean NOT NULL DEFAULT false CHECK (external_execution_initiated = false),
  generated_by text NOT NULL,
  generated_role operating_role NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS control_assurance_subject_idx ON control_assurance_assessments(subject_type, subject_id, created_at DESC);
CREATE INDEX IF NOT EXISTS adapter_certification_counterparty_idx ON adapter_certification_evidence(counterparty_id, created_at DESC);
CREATE INDEX IF NOT EXISTS control_audit_packets_scope_idx ON control_audit_packets(packet_scope, scope_reference, created_at DESC);

CREATE OR REPLACE FUNCTION prohibit_control_assurance_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Control assurance records are append-only';
END;
$$;

DROP TRIGGER IF EXISTS prohibit_control_assurance_assessment_change ON control_assurance_assessments;
CREATE TRIGGER prohibit_control_assurance_assessment_change BEFORE UPDATE OR DELETE ON control_assurance_assessments FOR EACH ROW EXECUTE FUNCTION prohibit_control_assurance_mutation();
DROP TRIGGER IF EXISTS prohibit_adapter_certification_change ON adapter_certification_evidence;
CREATE TRIGGER prohibit_adapter_certification_change BEFORE UPDATE OR DELETE ON adapter_certification_evidence FOR EACH ROW EXECUTE FUNCTION prohibit_control_assurance_mutation();
DROP TRIGGER IF EXISTS prohibit_control_audit_packet_change ON control_audit_packets;
CREATE TRIGGER prohibit_control_audit_packet_change BEFORE UPDATE OR DELETE ON control_audit_packets FOR EACH ROW EXECUTE FUNCTION prohibit_control_assurance_mutation();
