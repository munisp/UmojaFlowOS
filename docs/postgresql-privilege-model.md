# Canonical PostgreSQL privilege model

UmojaFlowOS separates the PostgreSQL schema owner from the application role. The
schema owner performs reviewed, forward-only migrations. The application role
used by the control plane holds only the data-manipulation privileges the
running code actually exercises, provisioned by the reviewable script
`database/postgresql/grants.sql`.

## Boundaries enforced at the database level

| Boundary | Enforcement |
| --- | --- |
| No schema mutation from the application | The application role owns no table and holds no `CREATE` privilege on `public`; `getPostgresPrivilegeBoundary()` asserts both. |
| Append-only audit and evidence | `activity_events`, `document_analysis_evidence`, `verification_reviewer_decisions`, `policy_decisions`, cutover reconciliation tables, notification deliveries, counterparty-risk assessments, and market observations receive `INSERT` only; no `UPDATE` and no `DELETE`. |
| No destructive access anywhere | `DELETE` is granted on no table in the canonical schema. |
| Consent immutability with lawful withdrawal | `verification_consents` receives `INSERT` plus a column-scoped `UPDATE (revoked_at)`. Scope, subject reference, purpose, and captured-by provenance cannot be altered. The column grant also satisfies the row-lock requirement of the analysis-job consent guard, which uses `SELECT ... FOR UPDATE`. |
| No stress-test fabrication | `treasury_stress_test_runs` receives no write privilege; stress-test execution remains fail closed until reconciled treasury inputs arrive from an authorised source. |

## Verification

`getPostgresPrivilegeBoundary()` reads live `has_table_privilege` results rather
than a static list, and the local PostgreSQL integration suites in both the
canonical control plane and the managed console assert that append-only
violations, deletable tables, schema ownership, and schema-create rights are all
empty or false. Attempting `UPDATE`/`DELETE` on `activity_events`, or `UPDATE` of
a consent purpose, is rejected by PostgreSQL as `permission denied`.
