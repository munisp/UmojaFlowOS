-- Adds a platform-managed periodic review purpose; no in-process timer is permitted.
ALTER TYPE scheduled_job_purpose ADD VALUE IF NOT EXISTS 'counterparty_risk_reviews';
