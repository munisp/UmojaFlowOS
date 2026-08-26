CREATE TABLE IF NOT EXISTS retention_delete_authorizations (
    decision_digest text PRIMARY KEY,
    expires_at timestamptz NOT NULL,
    issued_at timestamptz NOT NULL DEFAULT now(),
    consumed_at timestamptz,
    execution_status text NOT NULL DEFAULT 'issued',
    CHECK (length(decision_digest) = 64)
);

CREATE INDEX IF NOT EXISTS retention_delete_authorizations_pending_idx
    ON retention_delete_authorizations (expires_at)
    WHERE consumed_at IS NULL;

REVOKE ALL ON TABLE retention_delete_authorizations FROM PUBLIC;

CREATE TABLE IF NOT EXISTS retention_index_manifests (
    index_name text NOT NULL,
    index_uuid text NOT NULL,
    index_version text NOT NULL,
    archive_digest text NOT NULL CHECK (length(archive_digest) = 64),
    row_signature text NOT NULL CHECK (length(row_signature) = 64),
    recorded_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (index_name, index_uuid, index_version)
);

-- Table for incident events and evidence capture.
CREATE TABLE IF NOT EXISTS retention_incident_events (
    incident_id text PRIMARY KEY,
    alert_name text NOT NULL,
    status text NOT NULL,
    payload_digest text NOT NULL,
    received_at timestamptz NOT NULL DEFAULT now(),
    evidence_path text NOT NULL,
    containment_status text NOT NULL DEFAULT 'not_started'
);

REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;

-- Define Gateway Role (Writer/Issuer)
-- Capability: Issue authorizations and register index manifests.
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retention_gateway') THEN
        CREATE ROLE retention_gateway;
    END IF;
END $$;
GRANT INSERT ON TABLE retention_delete_authorizations TO retention_gateway;
GRANT INSERT, UPDATE ON TABLE retention_index_manifests TO retention_gateway;

-- Define Worker Role (Reader/Claimer)
-- Capability: Claim authorizations, read manifests, and record incidents.
DO $$ BEGIN
    IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'retention_worker') THEN
        CREATE ROLE retention_worker;
    END IF;
END $$;
GRANT SELECT, UPDATE ON TABLE retention_delete_authorizations TO retention_worker;
GRANT SELECT ON TABLE retention_index_manifests TO retention_worker;
GRANT INSERT, UPDATE, SELECT ON TABLE retention_incident_events TO retention_worker;
