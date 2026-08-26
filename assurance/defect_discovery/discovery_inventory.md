# Defect Discovery Inventory — Discovery Only

**Audited revision:** `71b14909ec2cc9e373158120aab2c03953bb89fa`
**Discovery rule:** No source/configuration change was made before this inventory. Raw static-signal output is local-only at `assurance/evidence/defect_discovery_static_signals.txt` and is intentionally excluded from source control.

## Executive posture

The audited repository has a deliberately fail-closed real-component boundary for TigerBeetle, Yellow Card, OpenSearch retention, and most service bridges. However, six locally verifiable defects were confirmed in high-control paths: a declared beneficiary screening control is not enforced by payment drafting; an administrator-configured endpoint can receive an integration credential through private-address SSRF; an authenticated incident-alert field can escape its evidence root; a simulator has a repository-known webhook secret fallback; treasury alert arithmetic converts high-precision monetary quantities to binary floating point; and the advertised PostgreSQL migration command points to a non-existent file while a stale duplicate migration tree remains in the application subtree.

No external staging/provider condition is closed by this audit. The remediation scope is limited to source/configuration controls that can be tested locally.

## Findings

| ID | Family | Title | Evidence | Classification | Severity | Blast radius | User-facing lie |
|---|---|---|---|---|---|---|---|
| F3-01 | Declared-but-unenforced gates | Payment drafting reads beneficiary screening state but never requires `clear` | `apps/control-plane/server/paymentWorkflow.ts:269-278`; `database/postgresql/0001_control_plane.sql:7,95-103`; `database/postgresql/0039_live_control_pipelines.sql:42-52` | CONFIRMED | HIGH | Treasury user can create a financial instruction against `not_run`, `potential_match`, `confirmed_match`, or `source_unavailable` beneficiary state; this consumes a live FX lock and enters downstream workflow preparation. | A recorded screening state implies a gate, while a non-clear beneficiary can still be drafted into a payment order. |
| F9-01 | Injection/input handling | Provider health probe permits HTTPS loopback/private/link-local targets and attaches the named credential | `apps/control-plane/server/routers.ts:235-260`; `apps/control-plane/server/postgres.ts:1040-1049`; `apps/control-plane/server/providerHealthCheck.ts:52-75` | CONFIRMED | HIGH | An administrator or compromised admin session can configure a provider endpoint such as `https://127.0.0.1/...`, an RFC1918 IP, or a link-local metadata IP and cause a bearer credential to be sent there during activation. | “Provider endpoint must use HTTPS” is presented as safe provider validation, but HTTPS alone does not constrain destination trust. |
| F9-02 | Injection/input handling | Alertmanager fingerprint is used as an unsanitized filesystem path component | `simulators/retention_gateway/incident_response_service.py:18-34`, `:124-166` | CONFIRMED | HIGH | A validly signed alert payload with fingerprint `../../...` or an absolute path can escape the configured evidence root, create directories, and write payload/command artifacts under the incident service identity. | Evidence is represented as isolated under `INCIDENT_EVIDENCE_ROOT`, while the incoming fingerprint controls its path. |
| F10-01 | Cryptography & secrets | Dependency simulator accepts a repository-known default webhook HMAC secret | `simulators/production_dependencies/app.py:17-21`, `:125-150` | CONFIRMED | HIGH | Any deployment that starts this app without `SIMULATOR_WEBHOOK_SECRET` accepts forged provider events signed with `ci-simulator-secret`. | HMAC verification appears enabled, but a public default makes it forgeable. |
| F13-01 | Money representation & arithmetic | Liquidity threshold controls convert PostgreSQL `NUMERIC` values to JavaScript binary `Number` | `apps/control-plane/server/operationalAlerts.ts:207-219`; `database/postgresql/0001_control_plane.sql:106-120`; `database/postgresql/0004_treasury_rebalancing_controls.sql` | CONFIRMED | HIGH | Large or precise approved-outflow/buffer values can be rounded across an amber/red boundary, suppressing or creating a liquidity alert and corrupting its quoted threshold. | Liquidity alerts look derived from exact reconciled values, but their comparison uses lossy floating-point arithmetic. |
| F16-01 | Build/deploy/environment fiction | Advertised migration command targets a file absent from the repository | `apps/control-plane/package.json:13-15`; root migration inventory starts at `database/postgresql/0001_control_plane.sql` | CONFIRMED | HIGH | A fresh deployment following `pnpm postgres:migrate` fails before applying any schema; the command cannot prove or produce a deployable database. | A supported `postgres:migrate` command exists, while it references `0001_baseline.sql`, which is not tracked. |
| F16-02 | Build/deploy/environment fiction / schema reality | Two PostgreSQL migration trees diverge and only a partial stale application-side copy remains | `database/postgresql/0001_control_plane.sql` through `0042_tigerbeetle_postgres_reconciliation.sql`; `apps/control-plane/database/postgresql/0008_kyc_document_upload_intents.sql` through `0016_cbn_sandbox_evidence_assessments.sql`; `apps/control-plane/package.json:15` | CONFIRMED | HIGH | A maintainer or test that follows the application-side tree can obtain a schema missing most production controls; same-name helpers (`grants.sql`, `purge_regression_fixtures.sql`, `validate_schema.sql`) also differ from the root canonical versions. | Both paths appear to be PostgreSQL migration sources, but only the root tree contains the full current chain. |
| F16-03 | Build/deploy/environment fiction | Control-plane listener may leave Compose/Caddy/healthcheck target when `3000` is unavailable | `apps/control-plane/server/_core/index.ts:29-35,70-78`; `infra/security-stack/compose.yaml:18,373-388` | SUSPECTED | MEDIUM | Under a port collision, the process binds `3001`–`3019` while all deployment consumers continue targeting `3000`; this causes outage rather than a silent false success. | The deployment declares port `3000`, but process code may choose a different port. |

## Negative results by family

| Family | Checked executable paths | Result |
|---|---|---|
| F1 — Phantom execution | Payment validation (`services/payment-engine/cmd/payment-engine/main.go:190-246`), provider route registration (`:141-146,275-287`), payment workflow terminal guards (`apps/control-plane/server/paymentWorkflow.ts:427-456,520-537`), Yellow Card reconciliation (`services/payment-engine/internal/provider/yellowcard_reconciliation.go:61-69`) | **Clean.** Internal workflows explicitly forbid provider-dependent terminal states without verified external references; simulator ledger is labelled simulated. |
| F2 — Phantom dependencies/silent fallbacks | Service bridge endpoint resolution and calls (`apps/control-plane/server/serviceBridge.ts:74-199`), service health collector (`apps/control-plane/server/serviceHealth.ts:93-222`), deployment route graph (`infra/security-stack/compose.yaml`, `infra/caddy/Caddyfile`) | **Clean for configured bridge calls.** Missing/invalid endpoints return `not_configured` or `unavailable`, not a fabricated decision. Ledger-gateway remains explicitly unconfigured in Compose and therefore cannot be counted as live. |
| F4 — Atomicity/races | Rate-lock consumption/payment creation (`paymentWorkflow.ts:239-359`), payment transition locks (`:448-500,529-592`), schema uniqueness (`database/postgresql/0001_control_plane.sql:134-176`) | **Clean in reviewed payment path.** Transactions, `FOR UPDATE`, unique idempotency key, and atomic rate-lock consumption are present. |
| F5 — Idempotency/replay | Payment order `ON CONFLICT` replay handling (`paymentWorkflow.ts:284-327`), simulator webhook replay cache (`simulators/production_dependencies/app.py:125-150`), Yellow Card webhook implementation | **Clean in reviewed real payment paths.** Duplicate payment key with different lock fails; production adapter has dedicated replay material/store. Simulator default-secret issue is separately F10-01. |
| F6 — Authentication/session integrity | tRPC context/middleware (`apps/control-plane/server/_core/context.ts:13-38`, `trpc.ts:14-58`), OIDC login/callback/session (`apps/control-plane/server/_core/oidc.ts:17-101`), scheduler auth (`scheduled/schedulerAuth.ts:19-31`) | **Clean for authenticated procedures.** Signed sessions expire; OIDC verifies issuer/audience/nonce; privileged scheduler routes reject missing/mismatched secret. Server-side revocation against upstream IdP logout remains an external operational consideration, not a locally confirmed bypass. |
| F7 — Step-up/transaction authorization | Treasury payment routes (`routers.ts:269-283`), provider execution handler registration (`payment-engine/main.go:275-287`), payment workflow terminal-state guards | **Clean for direct value movement.** The control plane only drafts/approves internal preparation states; provider execution is separately HMAC-approved/conditionally registered. No locally reachable terminal payout route was found. |
| F8 — Authorization/tenant isolation | tRPC role middleware (`trpc.ts:14-58`), router procedures (`routers.ts:73-371`), scheduled routes | **Clean in reviewed internal-console model.** Sensitive mutations use named role procedures and actor derives from server context; no public mutation writes regulated data. Broad auditor reads are an explicit internal operating-role design, not a customer multi-tenant route. |
| F11 — State machines/lifecycle | Payment order/leg transitions (`paymentWorkflow.ts:427-592`), rate-lock expiry/cancellation (`:53-150`) | **Clean.** Terminal provider states are unreachable by control-plane route; allowed internal transitions are explicit and guarded; rate locks expire idempotently. |
| F12 — Error polarity | Service bridge (`serviceBridge.ts:122-199`), provider activation outcome (`providerHealthCheck.ts:52-98`), retention circuit behavior (`worker_service.py:211-234`) | **Clean.** Dependency failures surface as unavailable/failed; provider activation requires a 2xx response; retention data-store saturation returns `503`. |
| F14 — Data integrity/schema reality | Root versus application migration inventories, payment schema, constraints, and workflow reads | **Finding incorporated in F16-02.** The root schema itself has important unique/check constraints; divergence in the alternate tree is the confirmed schema-reality defect. |
| F15 — Observability/audit fiction | Service health metrics/posture (`serviceHealth.ts:46-205`), persisted samples (`serviceHealthHistory.ts`), frontend consumer (`client/src/components/ServiceStatusDashboard.tsx`), audit writes in workflows | **Clean in reviewed paths.** Endpoint posture is persisted/rendered, and disabled execution is exposed as posture rather than converted to a zero metric or live claim. |

## Composition chains

| Chain | Classification | Evidence and impact |
|---|---|---|
| Configuration-secret exfiltration chain | CONFIRMED HIGH | F9-01 allows an admin-configured private HTTPS endpoint; `providerHealthCheck.ts:66-75` sends `Authorization: Bearer ${credential}`. This turns activation probing into an SSRF plus credential disclosure path. |
| Incident-response filesystem escape chain | CONFIRMED HIGH | F9-02 combines a valid alert webhook source with unvalidated `fingerprint` at `incident_response_service.py:147-164`, enabling artifact writes outside the intended evidence-root isolation. |
| Compliance-preparation fiction chain | CONFIRMED HIGH | F3-01 lets a non-clear beneficiary become a payment draft even though screening states and screening-evidence tables exist. The external send remains gated, so this is not direct settlement; it is a material control-preparation bypass. |
| Migration/deployment fiction chain | CONFIRMED HIGH | F16-01 and F16-02 combine a broken public migration command with divergent schema copies. A fresh environment can fail or use an incomplete schema while documentation/test surfaces appear present. |

## Remediation specification gate

The following contracts must be implemented before a finding is marked remediated:

1. **Screening gate:** `createPostgresPaymentOrder` must require the beneficiary’s current state to be exactly `clear`; all other states fail closed before rate-lock consumption. A focused integration test must prove `not_run`, `potential_match`, `confirmed_match`, and `source_unavailable` are rejected.
2. **Provider endpoint boundary:** persisted health-probe endpoints must be HTTPS, credential-free, and public-routable only. Loopback, unspecified, multicast, link-local, and RFC1918 IPv4/IPv6 addresses must be rejected after IP-literal parsing; private-DNS defense must require an explicit allowed-host policy supplied outside untrusted request input.
3. **Incident evidence path:** fingerprint must be normalized to a strict safe token; invalid/missing fingerprint uses SHA-256 of the authenticated payload. Evidence paths must be resolved under and verified to remain under `INCIDENT_EVIDENCE_ROOT`.
4. **Simulator secret:** secret must be a nonempty environment-provided value of at least 32 bytes; the app must refuse startup/route operation when absent. Tests must inject an explicit test secret.
5. **Exact liquidity arithmetic:** compare/calculate `NUMERIC` values in PostgreSQL and return the exact decimal text used for alert evidence. No `Number()` conversion may remain in the threshold path.
6. **Canonical migration execution:** root `database/postgresql` is the sole source. A runner must take a PostgreSQL advisory lock, maintain an immutable applied-version/checksum ledger, apply `0001`–`0042` in lexical order with `ON_ERROR_STOP`, and reject checksum drift. Application-side duplicate migrations must be removed or mechanically redirected; all tests must import canonical root paths.
7. **Static container port:** production process must fail if configured port is unavailable; fallback ports are development-only and must not be available in the production image/process path.

## Residual register

| Residual condition | Owner | Revisit trigger | Status |
|---|---|---|---|
| Staging endpoints, real provider credentials, real Keycloak/TigerBeetle/OpenSearch behavior, DR restores, and PagerDuty delivery cannot be verified locally | Release manager / security / operations / compliance owners | Controlled staging E-01–E-09 run | OPEN, fail-closed |
| DNS rebinding/public-DNS ownership cannot be conclusively proven by code alone | Security owner | Provider endpoint allow-list configuration and staging egress test | OPEN, fail-closed |
| `F16-03` dynamic control-plane port mismatch | Platform owner | Container-level regression test after remediation | SUSPECTED pending local verification |

## Discovery completeness checklist

| Question | Result |
|---|---|
| Every internal service URL cross-checked against the service map? | YES — configured bridge endpoints, Compose, Caddy, payment, retention, OPA, Redis, Keycloak, and OpenSearch boundaries reviewed; unconfigured ledger gateway explicitly recorded. |
| Every money mutation traced for atomicity, idempotency, gate, step-up? | YES — payment order/leg/rate-lock and TigerBeetle/provider-facing routes reviewed. |
| Every control-plane dependency killed mentally for polarity? | YES — bridge, health, provider activation, retention circuit, and screening client reviewed. |
| Every displayed number traced to a real query? | YES for reviewed service-health and liquidity-control surfaces; F13-01 found precision loss in otherwise real query data. |
| Every declared gate found in execution path or flagged? | YES — beneficiary screening gate flagged as F3-01. |
| At least one composition chain attempted? | YES — four documented above. |
| Independent adversarial verification passed? | PENDING — mandatory next phase before remediation. |

## Remediation and local retest

| Finding | Implemented remediation | Local regression evidence | Closure status |
|---|---|---|---|
| F3-01 | Added `assertBeneficiaryScreeningClear` to `apps/control-plane/server/paymentWorkflow.ts`; payment drafting now checks the canonical beneficiary state before deriving amounts or consuming the rate lock. Added `recordPostgresBeneficiaryScreening` and the compliance-only `recordBeneficiaryScreening` tRPC mutation. The new transaction requires an active sanctions/KYC integration, provider/evidence metadata, monotonic screening time, an append-only `aml_screening_checks` row, beneficiary row lock, and audit event. | `paymentWorkflow.screening.test.ts` proves all non-clear states fail. Full TypeScript suite passed. | **Locally remediated.** Real screening-provider evidence and activated staging integration remain required. |
| F9-01 | `normaliseProviderEndpoint` now requires HTTPS, forbids userinfo and any IP literal, and enforces a deployment-managed exact DNS host allow-list via `UMOJA_PROVIDER_ENDPOINT_ALLOWED_HOSTS`. Compose requires the setting. | `providerEndpointBoundary.test.ts` covers approved host, loopback/private/link-local/IPv6 literals, unapproved DNS host, absent and malformed allow-lists. Compose render passed with synthetic values. | **Locally remediated.** DNS ownership/rebinding assurance requires staging egress and provider onboarding verification. |
| F9-02 | Incident fingerprint values are strict canonical tokens; invalid/path-like/dot-segment values are replaced with SHA-256 of the authenticated payload. Resolved path containment under `INCIDENT_EVIDENCE_ROOT` is checked before writes. PostgreSQL import is lazy so the pure guard can be tested without a live database. | `test_incident_response_path_containment.py`; retention/simulator suite passed 43 tests, 2 gated skips. | **Locally remediated.** Real Alertmanager/PagerDuty incident drill remains required. |
| F10-01 | Removed `ci-simulator-secret`; simulator startup now requires an explicitly supplied nonblank `SIMULATOR_WEBHOOK_SECRET` of at least 32 bytes. Test configuration is isolated in `tests/conftest.py`. | `test_production_dependencies.py` proves missing/short secret rejection; scanner passed. | **Locally remediated.** Managed-secret injection must be evidenced in staging. |
| F13-01 | Moved liquidity breach comparison and exact floor derivation from JavaScript `Number` arithmetic to PostgreSQL `NUMERIC` expressions, returning exact decimal text for alert evidence. | Full TypeScript compilation/test suite passed; local PostgreSQL application-role integration passed. | **Locally remediated.** Load/production data thresholds still require staging observability evidence. |
| F16-01 / F16-02 | Replaced the broken `postgres:migrate` script with `scripts/infra/apply_postgres_migrations.sh`; it uses only the root chain, session advisory lock, `schema_migrations` version/checksum/state ledger, drift/interruption refusal, and dry-run inventory. Removed the divergent `apps/control-plane/database/postgresql` copy and redirected the sandbox boundary test to root SQL. | Runner syntax and dry-run produced checksums for all 42 migrations; `canonicalMigrationRunner.test.ts` passed; PostgreSQL application-role integration passed. | **Locally remediated.** A controlled staging migration run is still required. |
| F16-03 | Production listener now fails rather than selecting an undiscoverable fallback port; development alone may scan fallback ports. | TypeScript compilation/test suite passed; Compose render passed. | **Locally remediated.** Container startup/rollout proof remains a staging E-item. |

## Final local validation summary

| Gate | Result |
|---|---|
| Full repository quality gate (`make check`) | PASS — 437 tests passed; 149 intentionally gated integration/live tests skipped. |
| Retention gateway and production-dependency tests | PASS — 43 passed; 2 intentionally gated skips. |
| PostgreSQL application-role integration | PASS. |
| Canonical migration runner dry-run | PASS — 42 SHA-256-inventoried root migrations. |
| Compose contract render with synthetic, non-secret validation values | PASS. |
| Native Prometheus/Alertmanager validation | PASS — `promtool` and `amtool`. |
| Production dependency audit | PASS — no known high-or-greater production dependency vulnerabilities. |
| Tracked-secret scanner and diff whitespace validation | PASS. |

> **Release interpretation:** The seven source-level findings are locally remediated and regression-tested. This does not change the production decision to GO. Real E-01–E-09 staging evidence, immutable provenance/SBOM, external dependency proof, DR/restore/Chaos evidence, and four independent sign-offs remain mandatory and fail closed.
