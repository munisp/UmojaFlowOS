-- A person can authenticate through the identity provider without ever
-- receiving an operating role: no application code previously wrote to
-- user_role_assignments, so an administrator had no way to see who was
-- waiting or grant them access without direct database or Keycloak access.
-- This table records who reached the platform with no assigned role so an
-- administrator can find and act on them from the console. Rows are never
-- deleted, matching the platform's append-only evidence convention: a
-- resolved request is marked resolved, not erased.
CREATE TABLE operator_access_requests (
  subject TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  CHECK ((resolved_at IS NULL) = (resolved_by IS NULL))
);

CREATE INDEX operator_access_requests_pending_idx ON operator_access_requests (last_seen_at) WHERE resolved_at IS NULL;
