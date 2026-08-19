# Session state (working note)

Recorded so the current position is recoverable. Not a deliverable.

## Baselines as of the latest checkpoint (`d040220b`)

- Managed suite: 349 tests passing, 23 skipped (live cross-language regressions are opt-in).
- Canonical monorepo `make check`: green across Go, Rust, Python, TypeScript.
- Go 19 tests, Rust risk core 34, Rust ledger gateway 12, Python 39.
- Database verified clean after each full run via
  `database/postgresql/purge_regression_fixtures.sql`.

## Toolchain locations (reinstalled after the second sandbox reset)

- Go: `/usr/local/go/bin` (1.23.6)
- Rust: `$HOME/.cargo/bin` (rustup)
- Both must be on `PATH` before `make check`.

## Opt-in environment flags

- `POSTGRES_INTEGRATION_TEST=1` — enables all PostgreSQL integration suites.
- `GO_SERVICE_LIVE_TEST=1`, `RUST_SERVICE_LIVE_TEST=1`,
  `PYTHON_SERVICE_LIVE_TEST=1`, `LEDGER_GATEWAY_LIVE_TEST=1` — each starts the
  real service binary and drives it through the real control-plane bridge.

## Remaining open ledger items, by kind

Provider- or host-blocked (cannot be closed in this environment):
- Real provider adapters (needs approved credentials and licensed counterparties).
- Two Ollama evidence-only validations (needs a host that can hold an 8B model).
- Retiring transitional MySQL/TiDB access (needs the approved production cutover).

Audit and reconciliation work (closeable here):
- Audit every unchecked ledger item and classify it.
- Reconcile the ledger against the uploaded specifications and record gaps.
- Produce an evidence-based production-completion readiness score.
- Consolidate cutover mappings into dependency-ordered batches.

## Source documents

- `/home/ubuntu/upload/TheEnterpriseLiquidityOrchestrationandComplianceOSforAfrica-LinkedCross-BorderPayments.pdf`
- `/home/ubuntu/upload/StablecoinandCross-BorderPaymentsRegulation_Nigeria,Kenya,andSouthAfrica.pdf`
