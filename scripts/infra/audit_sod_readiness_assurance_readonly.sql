-- UmojaFlowOS readiness-assurance segregation-of-duties audit.
-- READ ONLY: run with an auditor/reporting role, never the schema owner or app role.
-- Usage: psql "$AUDIT_DATABASE_URL" -X -v ON_ERROR_STOP=1 -f audit_sod_readiness_assurance_readonly.sql

BEGIN TRANSACTION READ ONLY;
SET LOCAL statement_timeout = '30s';
SET LOCAL lock_timeout = '5s';

\echo 'A. Deployment/schema preconditions'
SELECT
  to_regclass('public.vasp_readiness_assurance_items') AS assurance_table,
  to_regtype('public.vasp_readiness_assurance_area') AS area_enum,
  to_regtype('public.vasp_readiness_assurance_status') AS status_enum;

\echo 'B. Exact state-machine constraint and unique dossier/area constraint'
SELECT c.conname, pg_get_constraintdef(c.oid, true) AS definition
FROM pg_constraint c
WHERE c.conrelid = 'public.vasp_readiness_assurance_items'::regclass
ORDER BY c.conname;

\echo 'C. Items that would violate submitter/verifier identity separation'
SELECT id, dossier_id, area, status, evidence_recorded_by, verified_by,
       external_verifier, evidence_recorded_at, verified_at
FROM vasp_readiness_assurance_items
WHERE status = 'externally_verified'
  AND verified_by = evidence_recorded_by;
-- Expected: zero rows. The migration 0040 CHECK constraint makes this invalid.

\echo 'D. Items with an incomplete externally-verified state'
SELECT id, dossier_id, area, status,
       evidence_uri, evidence_sha256, evidence_recorded_by, evidence_recorded_at,
       external_verifier, external_attestation_uri, external_attestation_sha256,
       verified_by, verified_at, verification_rationale
FROM vasp_readiness_assurance_items
WHERE status = 'externally_verified'
  AND (
    evidence_uri IS NULL OR evidence_sha256 IS NULL OR evidence_recorded_by IS NULL OR evidence_recorded_at IS NULL OR
    external_verifier IS NULL OR external_attestation_uri IS NULL OR external_attestation_sha256 IS NULL OR
    verified_by IS NULL OR verified_at IS NULL OR verification_rationale IS NULL OR
    verified_by = evidence_recorded_by
  );
-- Expected: zero rows.

\echo 'E. Items with an invalid open/evidence-recorded/rejected field combination'
SELECT id, dossier_id, area, status, evidence_uri, evidence_sha256,
       evidence_recorded_by, external_verifier, verified_by, rejection_rationale
FROM vasp_readiness_assurance_items
WHERE
  (status = 'open' AND (
    evidence_uri IS NOT NULL OR evidence_sha256 IS NOT NULL OR evidence_recorded_by IS NOT NULL OR
    external_verifier IS NOT NULL OR verified_by IS NOT NULL OR rejection_rationale IS NOT NULL
  ))
  OR (status = 'evidence_recorded' AND (
    evidence_uri IS NULL OR evidence_sha256 IS NULL OR evidence_recorded_by IS NULL OR
    external_verifier IS NOT NULL OR verified_by IS NOT NULL OR rejection_rationale IS NOT NULL
  ))
  OR (status = 'rejected' AND (
    evidence_uri IS NULL OR evidence_sha256 IS NULL OR evidence_recorded_by IS NULL OR rejection_rationale IS NULL
  ));
-- Expected: zero rows.

\echo 'F. Six-area / 58-point control total per dossier'
SELECT dossier_id,
       count(*) AS item_count,
       count(DISTINCT area) AS distinct_areas,
       sum(max_points) AS available_points,
       coalesce(sum(max_points) FILTER (WHERE status = 'externally_verified'), 0) AS verified_points
FROM vasp_readiness_assurance_items
GROUP BY dossier_id
ORDER BY dossier_id;

\echo 'G. Dossiers that lack exactly six unique areas totalling 58 points'
SELECT dossier_id,
       count(*) AS item_count,
       count(DISTINCT area) AS distinct_areas,
       sum(max_points) AS available_points
FROM vasp_readiness_assurance_items
GROUP BY dossier_id
HAVING count(*) <> 6 OR count(DISTINCT area) <> 6 OR sum(max_points) <> 58;
-- Expected: zero rows for each dossier initialized by the approved workflow.

\echo 'H. Attributable application audit events relevant to readiness assurance'
SELECT occurred_at, actor_subject, actor_role, action, object_type, object_id, correlation_id, metadata
FROM activity_events
WHERE action ILIKE '%readiness%assurance%'
   OR object_type ILIKE '%readiness%assurance%'
ORDER BY occurred_at DESC
LIMIT 500;
-- Review for unexpected manual/administrative behavior. The event set is evidence, not a substitute for the constraint checks above.

\echo 'I. Public and application-role privilege check (optional app_role variable)'
SELECT
  has_table_privilege('public', 'public.vasp_readiness_assurance_items', 'SELECT') AS public_select,
  has_table_privilege('public', 'public.vasp_readiness_assurance_items', 'INSERT') AS public_insert,
  has_table_privilege('public', 'public.vasp_readiness_assurance_items', 'UPDATE') AS public_update,
  has_table_privilege('public', 'public.vasp_readiness_assurance_items', 'DELETE') AS public_delete;
\if :{?app_role}
SELECT :'app_role' AS app_role,
       has_table_privilege(:'app_role', 'public.vasp_readiness_assurance_items', 'SELECT') AS can_select,
       has_table_privilege(:'app_role', 'public.vasp_readiness_assurance_items', 'INSERT') AS can_insert,
       has_table_privilege(:'app_role', 'public.vasp_readiness_assurance_items', 'UPDATE') AS can_update,
       has_table_privilege(:'app_role', 'public.vasp_readiness_assurance_items', 'DELETE') AS can_delete;
\endif

COMMIT;
