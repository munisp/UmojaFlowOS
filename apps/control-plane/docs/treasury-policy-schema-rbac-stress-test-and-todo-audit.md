# Treasury Policy Schema, RBAC, Stress Test, and Implementation Audit

**Assessment date:** 18 August 2026  
**Scope:** UmojaFlowOS canonical PostgreSQL policy controls for Nigeria (NGN), Kenya (KES), and South Africa (ZAR), with emphasis on the requested ZAR surge scenario.

## 1. Exact canonical PostgreSQL policy schema

The canonical migration is `database/postgresql/0004_treasury_rebalancing_controls.sql`. It is intentionally **recommendation-only**: no table, procedure, or interface in this scope can initiate a payment or move funds.

| Table | Purpose | Principal integrity controls |
|---|---|---|
| `treasury_buffer_policies` | Versioned, approved operating-buffer policy for one corridor/currency pair. | Corridor/currency pairing is constrained to Nigeria (NGN), Kenya (KES), or South Africa (ZAR); the target exceeds the minimum; percentages are bounded; a source period, source reference, policy URI, approver, and effective dates are mandatory; `(corridor, policy_version)` is unique. |
| `treasury_rebalancing_recommendations` | Evidence-backed proposed funding recommendation; it is not a transfer instruction. | Requires reconciled balance, reconciliation timestamp, balance source reference, verified funding gap, gap source reference, calculated minimum/target/recommendation, evidence JSON, expiry, proposer, and a lifecycle status. An approval or rejection requires all of `decided_by`, `decided_at`, and `decision_reason`. |
| `treasury_stress_test_runs` | Immutable evidence record for a deterministic scenario run. | `input_status` must be one of `completed`, `input_unavailable`, `input_stale`, or `input_inconsistent`. Numeric results are required **only** for `completed`; unavailable/stale/inconsistent inputs therefore produce an evidence-only exception rather than an invented amount. |
| `activity_events` | Cross-control immutable audit ledger used by policy proposal and decision helpers. | Records actor subject, actor role, action, object type/ID, timestamp, and structured metadata for attributable review. |

The relevant enumerations are `treasury_recommendation_status` (`proposed`, `approved`, `rejected`, `expired`, `superseded`) and `treasury_stress_test_status` (`completed`, `input_unavailable`, `input_stale`, `input_inconsistent`). The local canonical database validates **31** tables, including these controls.

## 2. Procedure-level RBAC

> RBAC is enforced in server middleware, not merely hidden in the interface. An unauthenticated caller is rejected; a caller lacking the applicable role receives `FORBIDDEN`.

| Role | Middleware membership | Treasury-policy permissions | Explicit restriction |
|---|---|---|---|
| `admin` | All operating procedures | Can record liquidity; can propose recommendations; is the **only** role that can approve or reject a PostgreSQL rebalancing recommendation. | Must supply a decision reason. Governance requires independent delegated review; no provider execution is enabled. |
| `treasury_operator` | `treasuryProcedure` | Can record reconciled liquidity and propose a PostgreSQL recommendation with source evidence, funding gap, and expiry. | Cannot use `decidePostgresRebalancing`; cannot approve its own proposal; cannot execute a transfer. |
| `compliance_officer` | `complianceProcedure` and audit reads | Can validate policy documentation and source lineage through compliance controls. | Cannot propose, approve, or reject a treasury recommendation under the current router. |
| `auditor` | `auditorProcedure` reads | Can inspect permitted ledgers and evidence. | Cannot record liquidity, propose, decide, or execute. |

The router exposes `treasury.proposePostgresRebalancing` through `treasuryProcedure` and `treasury.decidePostgresRebalancing` through `adminProcedure`. Role middleware defines `treasuryProcedure` as `admin` plus `treasury_operator`, while `adminProcedure` permits only `admin`.

## 3. ZAR settlement-outflow stress test: 50% surge

This is a **deterministic policy calculation**, not an operational forecast, financial recommendation, or fabricated treasury record. The proposed ZAR policy sets a 15% minimum buffer, 25% target buffer, and a maximum single recommendation of 15% of target, all measured against approved daily settlement outflow. [1]

Let **D** be the approved, reconciled ZAR 30-day average daily settlement outflow, **B** the reconciled ZAR available balance in allowed accounts, and **G** the verified near-term ZAR funding gap. The requested surge makes stressed daily outflow **1.50 × D**.

| Calculation | Result |
|---|---:|
| Stressed daily settlement outflow | `1.50 × D` |
| Stressed minimum buffer | `1.50 × D × 15% = 0.225 × D` |
| Stressed target buffer | `1.50 × D × 25% = 0.375 × D` |
| Maximum single recommendation | `15% × stressed target = 0.05625 × D` |
| Candidate recommendation | `min(0.375 × D − B, 0.05625 × D, G)` |

The result cannot be converted to a ZAR amount because UmojaFlowOS has no approved exposure basis **D**, no current reconciled balance **B**, and no verified near-term funding gap **G**. Supplying a numeric amount would be fabrication.

Under the schema’s fail-closed rules, the run must be persisted as follows:

| Condition | `input_status` | Required result |
|---|---|---|
| All inputs are reconciled, current, scope-valid, and currency-consistent | `completed` | Persist the calculation evidence and the bounded recommendation; retain human approval gate. |
| Any of D, B, or G is missing | `input_unavailable` | Persist an evidence-only exception; no recommendation amount and no funding action. |
| Reconciliation or source evidence is older than approved freshness policy | `input_stale` | Persist the limitation; request refreshed reconciliation; no recommendation. |
| Currency, account scope, or sources conflict | `input_inconsistent` | Persist the limitation; require human resolution; no recommendation. |

No path in the stress test selects a funding provider, creates a payment, or executes a transfer. External funding remains activation-gated.

## 4. Remaining implementation audit

The implementation ledger contains **66 unchecked** and **25 completed** items. There are **zero** `TODO` or `FIXME` markers in TypeScript, TSX, Go, Rust, or Python source, but that does **not** mean the ledger is complete.

| Classification | Status | Examples |
|---|---|---|
| Implemented and validated | Complete | Canonical PostgreSQL migrations; rebalancing schema, proposal/decision helpers and RBAC; rate-lock cancellation; payment-leg block/cancel controls; reporting review gates; KYC/KYB evidence ledger; loopback Qwen3-VL exact-digest safeguards; counterparty-risk assessment/evaluation/escalation controls. |
| Implemented but not eligible to claim end-to-end completion | Still open | PostgreSQL report lifecycle needs actual authorised legal-entity/report records to exercise draft-to-submitted flow; scheduled review callback must be deployed before a Heartbeat schedule can be created; full transitional MySQL-to-PostgreSQL cutover requires approved non-empty source data and reconciliation. |
| Provider- or authorisation-gated | Correctly open | Live payment execution, FX/market observations, sanctions screening, regulator submission, provider adapters, production private Ollama endpoint, authorised KYC/KYB evaluation material, and S3-backed customer document ingestion. |
| Remaining code/validation work | Still open | Full PostgreSQL port of every transitional path; end-to-end cross-service contract integration; comprehensive role-specific interface validation; production deployment and schedule activation; remaining source-data migration/reconciliation controls. |

Therefore, **not all remaining implementation TODO items are fully complete**. Marking them complete would be inaccurate and would violate the requirement not to fabricate provider data, customer records, balances, regulatory submission results, or deployment status.

## References

[1] [UmojaFlowOS Treasury Operating-Buffer Recommendation](./treasury-operating-buffer-recommendation.md)
