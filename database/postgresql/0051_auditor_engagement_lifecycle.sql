BEGIN;

-- OM Ch.10 (Auditors and Regulators) is not present in the shared export
-- beyond its title and a single sentence of §10.1. Built, like Ch.11, from
-- the "Auditors & regulators" lane of the Figure 3.1 cross-stakeholder map
-- (Ch.3) instead of sourced verbatim. Only two of that lane's four
-- phase-cells are legible in the source PDF (Phase 1 "Engagement letter ·
-- scope signed", Owner Legal+COO; Phase 2 "Read-only access provisioning",
-- Owner Eng+Legal) -- the Phase 3/4 cells are corrupted by a PDF-extraction
-- text-overlap artifact. Phase 3/4 here are therefore a conservative
-- inference from the audit-engagement lifecycle shape (fieldwork, then
-- annual re-review), not a transcription, and are flagged as such in the
-- server module's comments.
--
-- Chapter 1's own distribution table (§ front matter) gives real, legible
-- detail distinguishing this chapter's two archetypes: "External auditors"
-- get read-only data-room access during the annual audit (observed only,
-- no re-confirmation) -- that is what this table tracks. "Regulators" are
-- explicitly NOT given standing distribution -- excerpts are shown only
-- during supervised engagement, by exception -- which is exactly the shape
-- the platform's existing CBN Sandbox module (cbn_sandbox_dossiers et al.)
-- already covers. This migration is scoped to the external-auditor half
-- only; it does not duplicate regulator engagement tracking.
CREATE TYPE auditor_engagement_phase AS ENUM ('engagement_letter', 'access_provisioning', 'audit_fieldwork', 'annual_review');

CREATE TABLE auditor_engagement_records (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auditor_firm_name TEXT NOT NULL,
  engagement_reference TEXT NOT NULL,
  phase auditor_engagement_phase NOT NULL DEFAULT 'engagement_letter',
  engagement_letter_uri TEXT,
  engagement_letter_signed_at TIMESTAMPTZ,
  scope_note TEXT,
  auditor_subject TEXT,
  access_provisioned_at TIMESTAMPTZ,
  access_provisioned_by TEXT,
  fieldwork_note TEXT,
  fieldwork_started_at TIMESTAMPTZ,
  fieldwork_completed_at TIMESTAMPTZ,
  last_annual_review_at TIMESTAMPTZ,
  next_annual_review_due_at TIMESTAMPTZ,
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX auditor_engagement_records_created_idx ON auditor_engagement_records (created_at DESC);

COMMIT;
