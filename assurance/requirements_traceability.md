# UmojaFlowOS Mission-Critical Assurance Traceability Register

**Author:** Manus AI
**Assessment date:** 26 August 2026
**Baseline revision:** `a691850e1daae78195b1ab51e2aec445fd76a6f5` (`ci: automate staging rollback after failed deployment`)
**Candidate boundary:** The local worktree contains uncommitted tracked changes and untracked operational artifacts. This register distinguishes the clean baseline from the local remediation candidate.

## Assurance rule

> A requirement is not treated as satisfied merely because a test exists or a configuration file parses. It requires reproducible evidence in the recorded scope, no contradictory evidence, and a deployment/runtime boundary appropriate to the claim.

| Assurance area | Claim assessed | Evidence obtained | Status | Gap or release condition |
|---|---|---|---|---|
| Source provenance | The assessed revision is uniquely identifiable and reviewable. | `assurance/evidence/01_revision_boundary.txt`; clean checkout created at baseline HEAD. | **Partial** | The release candidate is not committed; its tracked and untracked changes are listed in `51_candidate_change_inventory.txt`. A release must reference one immutable commit. |
| Service build and unit verification | Core Go, Rust, Python, and TypeScript components compile and run their declared offline checks. | `17_make_check_authoritative.log`; `42_make_check_after_security_updates.log`. | **Pass—offline only** | Final declared target reports 422 passing and 149 skipped tests. Skipped tests are not evidence of integration correctness. |
| Contracts and policy configuration | Contract validation, activation contracts, edge policy, Keycloak realm security, secret-material scanning, and TypeScript checks execute. | `42_make_check_after_security_updates.log`. | **Pass—candidate** | Clean baseline initially failed secret-material validation; the scanner was corrected and must be committed/reviewed. |
| Control-plane authority boundaries | UI and server components do not claim regulatory approval or activate disabled integrations by default. | Boundary tests in final Makefile log; `15_focused_control_plane_retest.log`. | **Pass—offline boundary tests** | No proof that a real Keycloak, OPA/Permify, Kafka, Redis, or external regulator/provider is wired in staging. |
| PostgreSQL schema completeness | All tracked migrations can construct the canonical schema with reconciliation and evidence tables. | `20_fresh_postgres_migration_replay.log`; `21_fresh_postgres_schema_validation.log`. | **Pass—fresh replay** | Existing local `umojaflowos_dev` failed `make postgres-check` because migration `0042` was absent. Deployment migration state is therefore not proven. |
| Database least privilege | Application grants are portable and reconciliation evidence tables are append-only for the app role. | `24_grants_replay.log`: inserts allowed; deletes denied. | **Pass—fresh replay after remediation** | Requires a real production/staging role review and a migration-runner execution record. |
| PostgreSQL integration workflow | Counterparty onboarding workflow executes against a real least-privilege database runtime. | `62_postgres_app_role_integration_runner.log` and `63_make_postgres_app_role_integration.log`: fresh migration replay, separate schema-owner/application logins, grants, and gated suite pass. | **Pass—local disposable runtime** | The equivalent staging execution, deployed role review, and environment attestation remain required. |
| Ledger correctness and reconciliation | TigerBeetle posting, transfer identity, and PostgreSQL reconciliation behavior operate against a real cluster. | Go unit tests passed in `42_make_check_after_security_updates.log`; reconciliation schema replay passed. | **Not proven** | TigerBeetle live/staging tests are skipped or unavailable. No attested cluster, quorum, account binding, transfer, or reconciliation evidence exists in scope. |
| External AML/CFT and regulatory delivery | Screening and regulatory submission paths fail closed and record attributable external evidence. | Static validators and boundary tests passed; service configuration is activation-gated. | **Not proven** | Live credentials, provider allowlists, outbound TLS, response receipts, and replay/idempotency evidence were not supplied. |
| Monitoring and paging configuration | Prometheus rules and Alertmanager routing are semantically valid. | `32_native_monitoring_retest.log`: 41 rules parse and real `amtool` selects PagerDuty plus engineering receivers. | **Pass—configuration semantics** | No deployed Prometheus target, Alertmanager dispatch, PagerDuty test event, or dashboard data was observed. |
| Retention gateway controls | Signed manifest rows, mTLS adapter, replay prevention, database claim semantics, synthetic monitor, and Chaos/Locust artifacts are tested. | `26_retention_control_tests.log`: 47 passed, 2 skipped; targeted test artifacts under `tests/retention_gateway`. | **Partial** | These artifacts are currently untracked local additions, not baseline release code. Containerized OpenSearch/PostgreSQL and in-cluster Chaos tests remain skipped. |
| Dependency supply-chain posture | Production dependency graph contains no reported production dependency advisories. | `66_pnpm_audit_final_counts.json`: 0 info, low, moderate, high, and critical findings after reviewed direct/override updates. | **Pass—local locked graph** | Commit the lockfile/package changes, generate the release SBOM, and rerun the audit from the immutable release revision. |
| Container/deployment configuration | Compose model resolves structurally without embedding secret values. | `23_compose_config.log`. | **Pass—structural only** | No image build, signature/provenance, registry digest, startup, health, ingress, Kubernetes, or rollback execution was evidenced. |
| Chaos/resilience controls | Network/pool fault tests and scheduled validation artifacts are available. | Source tests and manifests exist; compile/pytest coverage in `26_retention_control_tests.log`. | **Not proven in cluster** | Kind/Helm and staging Chaos Mesh paths were not run. The fault controller, alert propagation, and recovery behavior are therefore unverified. |
| Backups, recovery, and operational readiness | Backup/restore, DR failover, reconciliation, and controlled recovery gates work in the target runtime. | Runbooks and scripts exist. | **Not proven** | No restore drill, TigerBeetle failover exercise, recovery timing evidence, or independent approval record was provided. |

## Mandatory release evidence still required

The following evidence must be produced against an immutable candidate revision in the actual staging environment before any production enablement claim:

| Evidence ID | Required artifact | Acceptance criterion |
|---|---|---|
| E-01 | Signed/tagged immutable release commit and reviewed change set | No uncommitted implementation, configuration, migration, or dependency-lock changes. |
| E-02 | Staging migration execution record | Fresh migration state includes `0042`; `validate_schema.sql` passes using the deployed schema owner and app role. |
| E-03 | Real PostgreSQL integration suite report | All database-gated suites execute with separate application and schema-owner identities; no test silently skips. |
| E-04 | TigerBeetle staging evidence | Cluster identity, quorum, account bindings, batch transfer idempotency, reconciliation run, and failure recovery all attest. |
| E-05 | Provider evidence | Keycloak JWKS/OIDC, AML screening, outbound webhook HMAC, regulatory endpoint receipt, and secret-reference resolution tests pass against real staging dependencies. |
| E-06 | Deployment evidence | Immutable image digest, SBOM/provenance, successful rollout, health checks, rollback test, and post-rollback verification. |
| E-07 | Observability evidence | Prometheus targets up, Alertmanager route test reaches a non-production PagerDuty service, and Grafana dashboard displays live series. |
| E-08 | Resilience evidence | Scheduled Chaos and disaster-recovery exercises run in staging with recorded detection, containment, reconciliation, and recovery evidence. |
| E-09 | Security review | Immutable-release SBOM, production dependency audit with zero reported advisories, secret scan, and independent security approval bound to the release SHA. |

## Traceability references

All evidence named above is retained under `assurance/evidence/` in the local candidate workspace. The release decision is recorded separately in `assurance/release_decision.md`.
