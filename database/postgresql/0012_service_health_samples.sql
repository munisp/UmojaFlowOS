-- Persisted service health samples.
--
-- A dashboard that reads a live endpoint can only ever show "now". A trend
-- requires history, and history requires storage. This table holds one row per
-- service per collection, recording exactly what the service reported and
-- nothing inferred: an unreachable service is stored as unreachable with its
-- observed reason, not as a gap that a chart might smooth over.
--
-- Counters are stored as jsonb rather than as columns because each service
-- reports its own counter names, and adding a column per counter would couple
-- the schema to service internals that legitimately change.

CREATE TABLE IF NOT EXISTS service_health_samples (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  service text NOT NULL,
  language text NOT NULL,
  status text NOT NULL,
  -- Null when the service was not reached; a fabricated zero would read as a
  -- fast response rather than as no response.
  latency_ms integer,
  uptime_seconds bigint,
  counters jsonb NOT NULL DEFAULT '{}'::jsonb,
  posture jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  -- The time the sample was collected by the control plane, which is the axis
  -- a trend is plotted against.
  collected_at timestamptz NOT NULL DEFAULT now(),
  -- The time the service itself claims it observed the values, when reported.
  service_observed_at timestamptz,

  CONSTRAINT service_health_samples_service_known
    CHECK (service IN ('payment-engine', 'risk-compliance-core', 'ledger-gateway', 'reporting-analytics')),
  CONSTRAINT service_health_samples_language_known
    CHECK (language IN ('go', 'rust', 'python')),
  CONSTRAINT service_health_samples_status_known
    CHECK (status IN ('healthy', 'unreachable', 'not_configured')),
  -- A healthy sample must carry a latency; an unhealthy one must not claim one.
  CONSTRAINT service_health_samples_latency_coherent
    CHECK ((status = 'healthy' AND latency_ms IS NOT NULL) OR (status <> 'healthy')),
  -- A non-healthy sample must say why, so a gap in a chart is always explicable.
  CONSTRAINT service_health_samples_reason_present
    CHECK ((status = 'healthy') OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
);

CREATE INDEX IF NOT EXISTS service_health_samples_service_time_idx
  ON service_health_samples (service, collected_at DESC);

CREATE INDEX IF NOT EXISTS service_health_samples_time_idx
  ON service_health_samples (collected_at DESC);
