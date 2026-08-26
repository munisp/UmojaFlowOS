# UmojaFlowOS 16-Finding Closure Register

**Author:** Manus AI
**Updated:** 26 August 2026
**Decision model:** A finding is **Closed** only when its implementation, verification result, and independently reviewable evidence all exist against one immutable release revision. A local pass never substitutes for controlled staging or production-operational evidence.

## Closure state summary

| State | Findings | Meaning |
|---|---|---|
| Closed locally, pending immutable release evidence | AUR-009, AUR-010, AUR-011, AUR-012, AUR-013, AUR-014 | Source/configuration remediation and local verification completed; commit/CI/provenance still required. |
| Implemented gate, staging evidence pending | AUR-002, AUR-003, AUR-004, AUR-005, AUR-006, AUR-008, AUR-015, AUR-016 | Scripts, tests, workflows, or gating paths exist, but the required controlled environment has not produced attested evidence. |
| Governance/release process pending | AUR-001, AUR-007 | Only an approved release workflow and immutable commit can close the finding. |

## Detailed closure matrix

| ID | Current state | Remediation and owner | Exact evidence required for closure | Verification command or procedure | GO acceptance criterion |
|---|---|---|---|---|---|
| AUR-001 | Open | **Release manager:** commit all reviewed source, configuration, migration, lockfile, test, and operational artifacts; create a signed/tagged candidate and SBOM/provenance. | Signed tag/release commit SHA; protected-branch PR approval; clean `git status`; SBOM/provenance attestation; CI run URLs. | `git status --porcelain`; `git rev-parse HEAD`; CI release workflow executes from tag only. | One immutable SHA is deployed, reviewed, and reproducibly builds the exact images/configurations under assessment. |
| AUR-002 | Open | **Integration owner:** execute all currently gated integration/live suites with actual staging dependencies and test credentials. | Per-suite JUnit/console reports; environment ID; test data correlation IDs; timestamps; reviewer attestation. | Enable documented env gates, including `POSTGRES_INTEGRATION_TEST=1` and service bridge/live-test variables; run `pnpm test`, Go/Rust/Python integration commands in staging. | Zero skipped required integration/live suites; all pass or an independently approved non-applicability record exists. |
| AUR-003 | Open | **Ledger owner:** provision/stage TigerBeetle with pinned cluster ID and account binding; execute transfer/reconciliation/failover controls. | Cluster identity and version; quorum evidence; account binding export; idempotency test result; reconciliation report; consensus-loss drill; recovery sign-off. | Run official TigerBeetle staging tests, `tigerbeetle-loadtest`, `reconcile_tigerbeetle_postgres.sh`, and DR failover/chaos runbook. | No unmatched ledger fact/intention; failed failover remains fenced; recovery returns to an agreed healthy state with reconciliation clean. |
| AUR-004 | Open | **Identity/compliance/provider owners:** activate controlled staging Keycloak, AML/CFT, webhook, regulatory, WORM, and notification integrations. | OIDC discovery/JWKS/audience test; AML request/response receipts; HMAC/replay/CIDR webhook evidence; regulatory receiver receipt; WORM legal-hold/object-lock metadata; notification test-event receipt. | Execute staging bridge suites and provider-specific contract scripts using recipient-owned sandbox destinations. | Success and fail-closed paths are both demonstrated; every evidence item has correlation ID, timestamp, owning system, and immutable retention reference. |
| AUR-005 | Gate implemented; staging proof pending | **Database/platform owner:** make migration replay and canonical schema validation a protected deployment prerequisite. | Migration manifest/checksum; executed migration IDs through `0042`; schema-validation output; deployment job URL. | `make postgres-check` against the deployed staging database after migration runner completion. | Schema validation passes on staging; migration ledger contains all tracked migrations; no manual drift. |
| AUR-006 | Local integration gate closed; staging proof pending | **Database owner:** use distinct non-superuser application and schema-owner staging test roles. | Role definitions and grants; application-role test log; proof of denied DELETE/DDL; schema-owner cleanup identity; no secret values. | `make postgres-app-role-integration` locally; execute equivalent staged job with injected `POSTGRES_DATABASE_URL` and `POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL`. | Counterparty suite passes under application role; schema-owner is used only for fixture cleanup/migration; app role has no audit-evidence delete privilege. |
| AUR-007 | Open | **Platform/release owner:** move all retention/mTLS/monitoring/Terraform/Chaos/Locust assets from local workspace into reviewed source and release pipeline. | PR/commit list; CI validations; container image digest; signed provenance; Helm render; security review record. | `git status --porcelain` clean; relevant GitHub Actions workflows green; `helm template` and image build checks pass. | Operational components are versioned, reviewed, built, and deployable from the same immutable release revision. |
| AUR-008 | Open | **SRE/DR owner:** execute backup restore and TigerBeetle/worker recovery drills on staging. | Backup metadata; restored environment identity; RTO/RPO measurement; failover timeline; reconciliation output; rollback/incident record; independent sign-off. | Controlled restore, consensus-loss/worker recovery, and reconciliation exercises using approved staging runbooks. | Measured RTO/RPO meet approved objectives; no loss/duplication; all recovery fences and reconciliation controls pass. |
| AUR-009 | Remediated locally | **Security tooling owner:** retain the uppercase-only secret-variable matcher and regression tests. | Commit SHA; test result; scanner output on release tree. | `python3 scripts/infra/validate_secret_material.py`; `python3 scripts/infra/test_validate_secret_material.py`. | Scanner passes and test proves literal uppercase secret exposure is rejected while camelCase Kubernetes configuration is not misclassified. |
| AUR-010 | Remediated locally | **Control-plane owner:** retain the current secret-reference/private-network hardening assertion. | Commit SHA; focused test result; compose rendered configuration without secret values. | `cd apps/control-plane && pnpm exec vitest run server/securityHardening.config.test.ts`; `docker compose ... config` if Docker is available. | Test passes and configuration uses a managed secret reference rather than a stale/literal DB URL contract. |
| AUR-011 | Remediated locally | **Control-plane/database owner:** retain explicit schema-owner fixture cleanup contract. | Commit SHA; `testPostgres.test.ts` pass; local/staging app-role integration evidence. | `cd apps/control-plane && pnpm exec vitest run server/testPostgres.test.ts`; `make postgres-app-role-integration`. | Missing schema-owner URL causes an explicit refusal; integration passes with distinct roles only. |
| AUR-012 | Remediated locally | **Database owner:** retain portable `current_database()` grant target and use the documented `-v app_role` interface. | Commit SHA; fresh migration/grants replay; privilege test showing insert allowed/delete denied. | `psql -v app_role=<role> -f database/postgresql/grants.sql`; schema/grant replay job. | Grants attach to the actual target database and preserve append-only evidence constraints. |
| AUR-013 | Remediated locally | **Application security owner:** preserve reviewed dependency upgrades/overrides and lockfile. | Commit SHA; production audit JSON; SBOM; regression test run. | `cd apps/control-plane && pnpm audit --prod --json`; `make check`. | Audit reports 0 info/low/moderate/high/critical vulnerabilities or an approved, time-bounded exception is documented. |
| AUR-014 | Remediated locally | **Application security owner:** maintain patched overrides for Mermaid, DOMPurify, fast-xml-parser, qs, Smithy resolver, body-parser, and related chain. | Final production audit JSON; dependency review; SBOM. | `pnpm audit --prod --json > assurance/evidence/dependency-audit.json`. | Final audit reports zero production advisories; if an upstream advisory reappears, the release gate fails before deployment. |
| AUR-015 | Open | **Observability/on-call owner:** deploy monitor, ServiceMonitor/PrometheusRule, recording rules, Alertmanager routing, and Grafana dashboard; test delivery through non-production PagerDuty. | Prometheus target screenshot/export; query output; Alertmanager receiver test incident ID; Grafana dashboard export; route validation result. | `amtool config routes test`; Prometheus `up{monitoring_source="synthetic"}`; controlled alert test to non-production PagerDuty receiver. | Targets are up, recording rules produce live series, both expected receivers receive test alerts, and the dashboard renders current values. |
| AUR-016 | Open | **Resilience owner:** execute scoped Kind and staging Chaos jobs, weekly Cron validation, and evidence retention. | Chaos resource/status; JUnit report; Prometheus before/during/after samples; cleanup proof; weekly report artifact. | `run_kind_synthetic_monitor_chaos.sh`; staging `pytest -m chaos`; scheduled validation CronJob report. | Fault is scoped, detected, alerted, recovered, cleaned up, and evidence retained; no production path is affected by staging/Kind tests. |

## Exact production-GO evidence bundle

The release manager must provide one directory or immutable artifact archive containing the following material before requesting a GO decision:

```text
release.json                         # tag, SHA, image digests, environment, timestamp
sbom.spdx.json                       # generated from the immutable images/source
provenance.json                      # build attestation
ci/                                  # all required CI/JUnit/log artifacts
migrations/                          # migration ledger, schema validation, role/grant evidence
ledger/                              # TigerBeetle cluster, transfer, reconciliation, DR evidence
integrations/                        # OIDC, AML, webhook, WORM, regulatory, notification evidence
observability/                       # targets, rules, routing, PagerDuty test, dashboard evidence
resilience/                          # restore, rollback, Chaos, recovery, reconciliation evidence
approvals/                           # independent release, security, compliance, and operations approvals
```

Each evidence artifact must include an immutable identifier, a UTC timestamp, an environment label, a correlation/run ID where applicable, and a SHA-256 digest. Secret values, live personal data, private keys, bearer tokens, and production webhook payloads must be redacted or represented by approved secret references.

## Revised decision rule

The decision changes from **NO-GO** to **GO** only when all 16 rows have closure evidence, the immutable release bundle validates, no critical/high production dependency finding exists, the required staging drills are successful, and independent security, compliance, release, and operations owners approve the exact release SHA. Until then, status remains **NO-GO** for live custody, payment execution, regulatory submission, or customer-impacting provider activation.
