BEGIN;

-- Customer-level country, reusing the corridor taxonomy already used for
-- onboarding overlays, corridor policies, and market observations. Lets the
-- console show which country a customer belongs to, so the country-specific
-- KYC document types (ng_/ke_/za_ prefixed, kyc_document_type) can be told
-- apart from one another instead of appearing as one undifferentiated list.
-- Nullable and set post-creation, mirroring archetype/tier from
-- 0044_customer_use_case_gates.sql: existing customers predate this
-- classification and are not retroactively assigned one.
ALTER TABLE customers
  ADD COLUMN country corridor_code;

COMMIT;
