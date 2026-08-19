# Workflow-by-Workflow PostgreSQL Validation Evidence

Aggregate suite totals say only that a large number of assertions passed. They do
not say which console workflow was exercised, against what, or what was proven
about it. This record replaces the aggregate with a per-workflow account: for
each implemented flow, the suite that exercises it, the count of passing
assertions, and the specific properties those assertions establish.

Every one of these tests runs against the **real local PostgreSQL 16 instance**
(`umojaflowos_dev`, peer-authenticated, 35 tables from migrations 0001–0011)
through the actual repository helpers and, where the workflow is reachable from
the console, the actual tRPC procedures with role-bearing contexts. No repository
is stubbed and no database is faked.

## Reproduction

```
cd /home/ubuntu/umojaflowos-platform
POSTGRES_INTEGRATION_TEST=1 pnpm exec vitest run server/*.integration.test.ts
sudo -u postgres psql -q -v ON_ERROR_STOP=1 -d umojaflowos_dev \
  -f /home/ubuntu/UmojaFlowOS/database/postgresql/purge_regression_fixtures.sql
```

Recorded result: **16 suites, 99 assertions, all passing.**

## Per-workflow evidence

| Workflow | Suite | Passing assertions | What is established |
| --- | --- | --- | --- |
| Payment order and leg lifecycle | `paymentWorkflow.integration.test.ts` | 16 | Every provider-dependent order and leg state is refused; transitions require a substantive reason; a leg needs a counterparty with a verified licence authorisation; rate locks expire idempotently; a consumed lock is bound to its order so the cancellation guard reads a real binding |
| Canonical write paths | `canonicalWritePathCutover.integration.test.ts` | 9 | Integration connections start unconfigured and never claim activation; a corridor policy cannot authorise its own execution; a rate lock requires a recorded market observation; every new write path records an attributable audit event |
| Repository and privilege model | `postgres.integration.test.ts` | 9 | Connection through the peer-authenticated role; the canonical table set is present; audit and evidence trails are append-only for the application role; analysis-job provenance persists per model role and fails closed when incomplete |
| Cutover reconciliation | `cutoverReconciliation.integration.test.ts` | 9 | Every mapped table reconciles against the real target schema; a dry run persists nothing; a mismatched approval hash blocks the apply |
| Operational alerting | `operationalAlerts.integration.test.ts` | 7 | A corridor with no approved policy or stale positions is indeterminate, never healthy; duplicate alerts are suppressed within the window; a single FX source yields null rather than a fabricated zero spread |
| Compliance alert lifecycle | `complianceAlerts.integration.test.ts` | 6 | Alerts raise only from enabled policies with verbatim evidence; acknowledgement is explicitly non-resolving; escalation requires a real open case; escalation and dismissal are terminal; every step is attributed |
| KYC document lifecycle | `kycDocumentLifecycle.integration.test.ts` | 6 | Document and intent records stay byte-free with storage references only; a checksum mismatch is rejected at finalisation; a rejected document cannot re-enter review |
| KYC adversarial and privacy | `kycAdversarial.integration.test.ts` | 6 | Evidence cannot express an approval; a strong tamper signal stays review-required; evidence rows carry no extracted personal data; a truncated source digest is refused by constraint |
| Multi-language service boundary | `serviceWorkflow.integration.test.ts` | 6 | A tampered Go audit chain is rejected in the same flow that accepts a valid one; auditors and treasury operators are refused; an unconfigured service never resolves to ALLOW or to a balanced ledger verdict |
| Analysis-job provenance | `analysisJobProvenance.integration.test.ts` | 5 | Visual-primary and text-fallback provenance persist distinctly; an unreachable runtime or drifted digest writes no job at all; a job whose provenance contradicts the resolver is rejected |
| Regulatory report lifecycle | `regulatoryReportLifecycle.integration.test.ts` | 5 | Legal-entity registration is administrator-only; a report advances for each corridor regulator; an inverted period and an unknown entity are both refused |
| Consent boundary | `analysisConsentBoundary.integration.test.ts` | 4 | An expired consent, a scope mismatch, and an unknown consent each write no analysis job |
| Compliance case disposition | `complianceCaseWorkflow.integration.test.ts` | 4 | A case reaches reported and then closed with audit evidence; a closed case cannot reopen; a disposition without an attributable rationale is refused |
| Treasury rebalancing | `treasuryRebalancing.integration.test.ts` | 3 | A recommendation without an approved buffer policy fails closed; the proposal and independent-approval path is exercised; reads create nothing |
| Regulatory deadlines | `regulatoryDeadlines.integration.test.ts` | 3 | A deadline inside the horizon reminds exactly once per day; one beyond the horizon is untouched; a deadline without a source reference is refused |
| Licence registry authorisation | `registryAuthorization.integration.test.ts` | 1 | Licence lifecycle transitions are administrator-only, persisted, and auditor-visible |

## Fixture hygiene, and a defect this exercise found

The suites deliberately write real rows rather than mocks, so the purge script is
the counterpart that keeps the canonical database free of synthetic operational
data. Verifying it as part of this exercise revealed that it was **silently
incomplete**: five tables were never matched by any of its patterns, because the
alerting suites act as `cutover-admin-<epoch>` and `regression-alert-admin`,
neither of which appeared in the fixture-actor list.

| Table | Rows surviving every previous purge |
| --- | --- |
| `notification_deliveries` | 366 |
| `alert_policies` | 132 |
| `compliance_alerts` | 80 |
| `compliance_cases` | 64 |
| `corridor_policies` | 20 |

These had accumulated across every run since the alerting workflows were added.
The script now collects the whole alerting subtree and deletes it in dependency
order (deliveries and alerts before policies; escalated cases before the alerts
that reference them). The full cycle was verified end to end: after a clean
purge, a fresh 99-assertion run populated 21 tables, and the purge returned the
database to **zero rows in every table**.

## Scope and honest limits

## Console form workflow coverage

The table above covers the server side of each workflow. The console side is
covered separately by DOM regressions that render the real components and drive
the real interactions. Auditing this found that **five of the twelve console
forms had no DOM coverage at all**: SAR/STR filing, regulatory deadlines, KYC
document upload, KYC document review, and the three PostgreSQL reporting forms.
All are now covered.

| Console form | Regressions | Notable properties proven |
| --- | --- | --- |
| Payment order and leg controls | 15 | Provider-owned states offer no control; transitions require a reason |
| SAR/STR filing | 8 | No draft affordance without a real case; a blank submission reference does not mark a filing submitted; terminal filings offer no transition |
| KYC document upload | 7 | Unsupported, empty, and oversized files are refused before any intent is created; only metadata and a full SHA-256 reach the control plane while bytes go to storage; a failed storage upload does not finalise the intent |
| Treasury rebalancing | 10 | Proposal withheld without an approved policy; a proposer cannot decide their own recommendation |
| Compliance case controls | 9 | Disposition requires an attributable rationale |
| KYC evidence workspace and controls | 18 | Evidence never expresses an approval; per-role visibility including unauthenticated |
| Reporting forms (customer, draft, transition) | 11 | Values are trimmed; a malformed evidence manifest blocks the transition; empty optional fields are omitted rather than sent blank |
| Rate lock controls | 7 | Cancellation limited to live unconsumed locks |
| Analysis job submission | 7 | Submission bound to an active consent |
| KYC document review | 5 | Review control withheld from non-reviewing roles and from terminal states; a token rationale keeps the control disabled |
| Counterparty authorisation | 4 | Lifecycle control gated while status stays readable |
| Console module actions | 7 | Role-aware action surface |

A structural guard (`consoleFormCoverage.test.ts`) now asserts that every console
component rendering a form has a DOM regression, so this gap cannot silently
reopen. It was verified with a negative control: hiding one test file fails the
guard and names the uncovered component.

### Form to database, without a test double in the middle

Component tests and server tests can each be correct while the seam between them
is wrong: a renamed field, a mis-shaped date, a value the form sends as a string
and the procedure expects as a number. Neither suite would notice.
`server/consoleFormToDatabase.integration.test.tsx` closes that seam. It renders
the real form, binds its submit handler to a real `appRouter` caller with a
role-bearing context, drives the real DOM interaction, and reads the row back
out of PostgreSQL.

| Path | What reaching the database proves |
| --- | --- |
| Customer onboarding | The form's trimming survives to the stored row; a treasury operator's identical submission is refused by the live gate and writes nothing |
| Regulatory deadline | Both non-default select values survive; the `datetime-local` string becomes a valid instant rather than a shifted or invalid date |
| SAR/STR draft | The draft binds to a real case and cannot be originated as submitted |
| Report draft | Persists with the selected regulator and corridor at `draft`, against a registered legal entity |
| Report transition | A transition to `submitted` without a channel reference is refused by the server and the record stays at `draft` |
| KYC document review | A real presigned upload of real bytes precedes finalisation; the stored decision is attributed to the acting officer |
| Compliance case disposition | The disposition changes the stored status with its rationale |
| Rate lock | Reaches the real procedure and is refused; see below |
| Payment order | Reaches the real procedure with a real customer and beneficiary and is refused on the rate lock alone; no order is written |
| Treasury rebalancing proposal | Rendered against the live policy list read through the real procedure; with no approved policy the form is withheld entirely |

This suite is verified as a real detector rather than a formality: renaming one
form field to a name the procedure does not expect makes the assertion fail with
a null identifier, and neither the component suite nor the server suite notices.

The rate-lock and payment-order forms cannot be driven to a persisted row, and
that is the correct outcome rather than missing coverage. A rate lock requires a
market observation, a market observation requires an active FX integration, and
**no code path activates an integration** — `UPDATE integration_connections`
appears nowhere in the server, because activation demands a credential-verified
provider health check. What is proven instead is that the form reaches the real
procedure and the procedure refuses, rather than the form silently doing nothing.

The treasury rebalancing proposal form is the same shape of honest limit. No
application path inserts a buffer policy — `INSERT INTO
treasury_buffer_policies` appears nowhere in the repository — because an
approved buffer policy is a governance artefact rather than a console entry.
The regression therefore reads the live policy list through the real procedure
and asserts the console's actual behaviour for that state: the proposal form is
withheld entirely and no affordance is offered.

### Two real defects this coverage surfaced

Writing these tests was not a formality; it found two genuine problems in the
upload path. First, the component read the selected file through
`new FormData(form)`, which yields a *serialised copy* rather than the selected
`File`; it now reads `input.files[0]` directly, so the checksum is computed over
exactly the bytes that are uploaded. Second, `crypto.subtle.digest` was passed a
bare `ArrayBuffer`, which fails an identity check across realm boundaries; it now
passes a typed-array view. Both are correctness fixes in shipped code, not test
scaffolding.

## Scope and honest limits

These assertions establish workflow behaviour against the canonical schema. They
do not establish provider behaviour, because no authorised payment, FX, screening,
or submission counterparty is configured; those paths remain activation-gated and
are asserted only in their refusing direction. Nor do they constitute a
production deployment: this is a local instance rebuilt from migrations, and the
cutover readiness reported by the repository is explicitly local-only.
