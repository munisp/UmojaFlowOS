# UmojaFlowOS Latest Release Closure-Evidence Matrix

**Author:** Manus AI
**Release SHA:** `31b5cb2d83520029f315cf1f3b6ea5e59896013e`
**Reference branch:** `origin/main` verified 26 August 2026
**Decision rule:** A finding is closed only when the required artifact is generated from this exact immutable SHA, has a SHA-256 digest in `release.json`, and is independently reviewed. A local test, simulator result, or structurally valid manifest does not replace controlled staging evidence.

## Evidence status and closure requirements

| Finding | Current state at latest SHA | Source remediation | Exact closure evidence | Required E-item(s) | Acceptance condition |
|---|---|---|---|---|---|
| AUR-001 — immutable provenance | **Open** | Release-evidence schema, verifier, and protected workflow exist. | Signed/annotated tag, clean worktree output, protected review export, CI provenance, SBOM, immutable image digests. | E-01, E-09 | Tag, source SHA, provenance, SBOM, and deployed image digests all resolve to `31b5cb2…` or a newer reviewed release SHA. |
| AUR-002 — skipped integration/live suites | **Open** | Staging evidence pack and release gate define the required suite evidence. | JUnit/console reports for every applicable gated suite, timestamps, environment ID, test correlation IDs, non-applicability records if any. | E-03, E-04, E-05, E-08 | No required suite remains skipped; each passes or has independent approved non-applicability. |
| AUR-003 — TigerBeetle ledger evidence | **Open** | Staging load, reconciliation, DR, and chaos scripts are versioned. | Cluster/version/quorum output, account binding, idempotency/transfer report, reconciliation report, consensus-loss fence/recovery report. | E-04, E-08 | No unexplained ledger discrepancy; indeterminate failover is fenced; post-recovery reconciliation is clean. |
| AUR-004 — external identity/compliance/provider evidence | **Open** | Contract simulators, OIDC/webhook controls, WORM gateway, and staging tests are versioned. | Keycloak discovery/JWKS/audience success and refusal logs; AML receipts; HMAC/replay/CIDR webhook outcomes; regulatory recipient receipt; WORM/Object Lock metadata; notification receipt. | E-05 | Success and fail-closed paths have recipient/system correlation IDs and immutable evidence references. |
| AUR-005 — deployment migration drift | **Gate implemented; staging proof pending** | Portable grants and fresh replay validation exist. | Staging migration job output, migration ledger through `0042`, schema validation output, deployment job identifier. | E-02 | Every tracked migration appears once; canonical schema validation passes; no manual schema drift. |
| AUR-006 — application-role PostgreSQL workflow | **Locally remediated; staging proof pending** | `make postgres-app-role-integration` enforces distinct schema-owner/application roles. | Staging role/grant export, app-role test report, denied DELETE/DDL proof, schema-owner cleanup identity. | E-03 | Counterparty lifecycle passes under app role; schema owner is limited to migration/fixture cleanup; app role cannot delete audit/reconciliation evidence. |
| AUR-007 — operational assets outside prior provenance | **Open** | Retention, mTLS, monitoring, Terraform, Chaos, and Locust sources are committed to main. | Protected PR/commit history, CI validation results, Helm render, immutable image build/signature/provenance, security review. | E-01, E-06 | Every operational asset is built and deployed from the same immutable release revision. |
| AUR-008 — restore/DR operational evidence | **Open** | Restore, failover, reconciliation, incident, and Chaos runbooks are versioned. | Backup identity, restored environment identity, RTO/RPO measures, failover timeline, reconciliation result, incident/rollback record. | E-08 | RTO/RPO meet approved objectives; no loss/duplication; recovery/reconciliation/fences succeed. |
| AUR-009 — secret scanner false positive | **Locally remediated; immutable CI evidence pending** | Scanner recognizes only approved `/run/secrets/` and `/var/run/secrets/` `_FILE` references; regression tests added. | Immutable-SHA scanner output and regression-test report. | E-01, E-09 | Literal secret material is rejected; approved mounted-secret references and normal Kubernetes options pass. |
| AUR-010 — stale hardening assertion | **Locally remediated; immutable CI evidence pending** | Hardening test now verifies current managed-secret/private-network contract. | Immutable-SHA focused test report and rendered configuration with values redacted. | E-01, E-06 | Test passes and deployed configuration contains no stale/literal database secret contract. |
| AUR-011 — schema-owner cleanup boundary | **Locally remediated; staging proof pending** | Cleanup refuses application-connection fallback and requires `POSTGRES_TEST_SCHEMA_OWNER_DATABASE_URL`. | Immutable-SHA unit test and staged distinct-role integration report. | E-03, E-09 | Missing schema-owner URL is refused; only schema-owner cleanup path executes. |
| AUR-012 — hard-coded database grants | **Locally remediated; staging proof pending** | `grants.sql` uses `current_database()` and replay checks insert/no-delete posture. | Applied grants artifact, actual target database proof, insert-permitted/delete-denied test. | E-02, E-03 | Privileges bind to staged target database and preserve append-only evidence controls. |
| AUR-013 — critical/high dependency chain | **Locally remediated; immutable audit pending** | Reviewed direct/transitive dependency updates and lockfile remediation. | Production `pnpm audit --prod --json`, SBOM, immutable CI report. | E-01, E-09 | Audit reports zero production critical/high findings, or an independent time-bounded exception is recorded. |
| AUR-014 — moderate/low dependency chain | **Locally remediated; immutable audit pending** | Reviewed dependency overrides now produce a zero-advisory local graph. | Immutable production audit, SBOM review, security-owner approval. | E-09 | Audit reports zero production advisories; release gate fails on reintroduction. |
| AUR-015 — live observability and notification delivery | **Open** | ServiceMonitor, recording rules, PrometheusRule, Alertmanager routes, dashboards, and synthetic monitor are versioned. | `up=1` target query/export, recording/alert query output, Alertmanager route output, non-production PagerDuty event ID, Grafana dashboard export. | E-07 | Live targets and series exist, both receivers receive expected test alert, dashboard is populated. |
| AUR-016 — chaos/CronJob execution | **Open** | Kind/staging Chaos resources, scheduled validation, reports, and tests are versioned. | Chaos resource/status, JUnit, before/during/after metrics, cleanup proof, scheduled report, restore/failover outputs. | E-08 | Fault is scoped, detected, alerted, recovered, cleaned up, and evidence retained without affecting production. |

## Four-role approval payload template

The approval objects below are the exact fields accepted by `release_evidence_manifest.schema.json` and `verify_production_release_evidence.py`. Each `subject` must identify a different human or approved organizational signing identity. Do not use placeholder subjects in an actual release manifest.

```json
[
  {
    "role": "release_manager",
    "subject": "REPLACE_WITH_DISTINCT_RELEASE_MANAGER_IDENTITY",
    "release_sha": "31b5cb2d83520029f315cf1f3b6ea5e59896013e",
    "approved_at": "2026-08-26T00:00:00Z"
  },
  {
    "role": "security_owner",
    "subject": "REPLACE_WITH_DISTINCT_SECURITY_OWNER_IDENTITY",
    "release_sha": "31b5cb2d83520029f315cf1f3b6ea5e59896013e",
    "approved_at": "2026-08-26T00:00:00Z"
  },
  {
    "role": "compliance_owner",
    "subject": "REPLACE_WITH_DISTINCT_COMPLIANCE_OWNER_IDENTITY",
    "release_sha": "31b5cb2d83520029f315cf1f3b6ea5e59896013e",
    "approved_at": "2026-08-26T00:00:00Z"
  },
  {
    "role": "operations_owner",
    "subject": "REPLACE_WITH_DISTINCT_OPERATIONS_OWNER_IDENTITY",
    "release_sha": "31b5cb2d83520029f315cf1f3b6ea5e59896013e",
    "approved_at": "2026-08-26T00:00:00Z"
  }
]
```

The release verifier rejects duplicated `subject` values, a missing required role, a role outside the four-role enum, a release SHA mismatch, a missing timezone in `approved_at`, any missing E-artifact, or any artifact hash mismatch.

> A structurally valid approval payload does not grant production authority by itself. Each signatory must review the exact immutable evidence bundle and approve only after the relevant acceptance conditions in this matrix are met.

## Required production GO statement

Production status may change to **GO** only when all 16 rows above have closure evidence, E-01 through E-09 validate against the final immutable release SHA, no critical/high production dependency finding exists, controlled staging recovery drills pass, and all four independent role approvals are present.
