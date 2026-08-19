# Session state — credential audit, metrics history, retry, language pass, middleware

## Environment facts (re-verified this session)
- Toolchains: Go at `/usr/local/go/bin`, Rust at `$HOME/.cargo/bin`, Python 3.11.
  `export PATH=$HOME/.cargo/bin:/usr/local/go/bin:$PATH` before `make check`.
- PostgreSQL: local, peer auth, database `umojaflowos_dev`, application role is
  `ubuntu`. Grants script requires `-v app_role=ubuntu`.
- Migrations now run 0001–0012. 36 tables.
- Service identifiers used everywhere (schema, charts, bridge) are hyphenated:
  `payment-engine`, `risk-compliance-core`, `ledger-gateway`, `reporting-analytics`.
- Host memory is ~3.9 GB total. Kill stray `target/debug/*`, `uvicorn`, and
  `vitest` processes when the sandbox warns about memory.
- Fixture purge: `sudo -u postgres psql -q -d umojaflowos_dev -f
  /home/ubuntu/UmojaFlowOS/database/postgresql/purge_regression_fixtures.sql`.
  `service_health_samples` is append-only to the application role, so its test
  cleanup runs as the `postgres` owner.

## Completed this round
1. Credential audit trail — reads the existing append-only `activity_events`
   rather than a second table; credential changes now record
   `previousSecretReference`. Router: `integrationCredentialAuditTrail`
   (admin-only). Tests: `server/credentialAuditTrail.integration.test.ts` (4),
   `client/src/components/CredentialAuditTrail.test.tsx` (6).
2. Metrics history — migration `0012_service_health_samples.sql`, module
   `server/serviceHealthHistory.ts`, scheduled collector at
   `/api/scheduled/service-health-collector`, router reads
   `serviceHealthHistory` / `serviceAvailabilitySummary` and admin mutation
   `captureServiceHealthSample`. Tests:
   `server/serviceHealthHistory.integration.test.ts` (9).
3. Trend charts — `client/src/components/ServiceTrendCharts.tsx` using recharts
   (already a dependency). Unreachable renders as a gap, never zero; throughput
   is a delta with counter-reset intervals dropped; availability is null rather
   than 100% when unobserved. Tests: `ServiceTrendCharts.test.tsx` (9).
   jsdom needs a `ResizeObserver` stub for the responsive container.

## Remaining
- One-click retry for failed submissions.
- Stakeholder language pass (e.g. "PostgreSQL cutover" on the overview panel).
- Middleware: Temporal, Permify, Kafka/Dapr/Fluvio, Redis, OpenSearch,
  TigerBeetle, Keycloak, Mojaloop, APISIX/open-appsec, Sedona/GeoLibre/lakehouse.
- Four pre-existing externally blocked items (provider credentials, MySQL
  cutover, two Ollama validations needing >3.9 GB).
