-- Performance hot-path indexes (ufp_ prefix). Complementary to the
-- correctness indexes in earlier migrations; every statement is idempotent.
-- Target: sub-10ms p99 for worker polls and single-row lookups at 10M rows.

BEGIN;

-- Settlement saga: open-saga sweep across all stages (dashboard + sweeper).
-- Existing settlement_saga_stage_idx leads with stage; cross-stage sweeps
-- by recency need a terminal-filtered partial index.
CREATE INDEX IF NOT EXISTS ufp_saga_open_by_recency_idx
    ON settlement_saga (tenant_id, updated_at DESC)
    WHERE terminal_at IS NULL;

-- Outbox worker poll: unleased, unpublished, due rows. The existing
-- settlement_outbox_available_idx cannot exclude leased rows, so workers
-- contending on FOR UPDATE SKIP LOCKED scan leased rows too.
CREATE INDEX IF NOT EXISTS ufp_outbox_poll_unleased_idx
    ON settlement_outbox (tenant_id, available_at, created_at)
    WHERE published_at IS NULL AND leased_until IS NULL;

-- Outbox lease recovery: find expired leases without a full scan.
CREATE INDEX IF NOT EXISTS ufp_outbox_lease_expiry_idx
    ON settlement_outbox (leased_until)
    WHERE published_at IS NULL AND leased_until IS NOT NULL;

-- Inbox: saga correlation lookup (FK settlement_inbox.tenant_id/saga_id has
-- no supporting index; joins from evidence queries degrade to seq scans).
CREATE INDEX IF NOT EXISTS ufp_inbox_saga_lookup_idx
    ON settlement_inbox (tenant_id, saga_id)
    WHERE saga_id IS NOT NULL;

-- Saga transitions: evidence timeline read (PK covers saga+version; this
-- covers tenant-wide time-ordered audit export).
CREATE INDEX IF NOT EXISTS ufp_saga_transition_audit_idx
    ON settlement_saga_transition (tenant_id, created_at DESC);

-- Stablecoin intents: status queue poll + reconciliation run correlation.
CREATE INDEX IF NOT EXISTS ufp_stablecoin_intent_status_idx
    ON stablecoin_intent (tenant_id, status, created_at)
    WHERE status = 'PENDING';

-- Fabric attestation queue: worker poll on due, unleased pending rows.
CREATE INDEX IF NOT EXISTS ufp_fabric_queue_poll_idx
    ON fabric_attestation_queue (state, next_attempt_at)
    WHERE state IN ('pending', 'unknown') AND completed_at IS NULL;

-- Service health samples: per-service latest-N dashboard reads.
CREATE INDEX IF NOT EXISTS ufp_health_samples_service_idx
    ON service_health_samples (service, collected_at DESC);

-- Remittance/BDC rolling-cap windows are indexed in 0064; add the reporting
-- return scan (per-day corridor aggregation for the CBN daily return).
CREATE INDEX IF NOT EXISTS ufp_remittance_daily_return_idx
    ON remittance_orders (tenant_id, corridor, created_at);

ANALYZE settlement_saga;
ANALYZE settlement_outbox;
ANALYZE settlement_inbox;
ANALYZE remittance_orders;
ANALYZE bdc_tickets;

COMMIT;
