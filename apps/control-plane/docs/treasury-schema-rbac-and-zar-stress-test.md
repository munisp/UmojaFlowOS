# Treasury PostgreSQL Schema, RBAC, and ZAR Stress Test

## PostgreSQL control model

The canonical migration is `database/postgresql/0004_treasury_rebalancing_controls.sql`. It adds three PostgreSQL-only tables. `treasury_buffer_policies` is the approved policy source of truth; it binds one versioned policy to a corridor and currency, records the approved daily outflow basis and policy percentages, restricts permitted account kinds, and requires source lineage and an approver. Its corridor/currency check prevents Nigeria (NGN), Kenya (KES), and South Africa (ZAR) combinations from being mixed.

| Table | Purpose | Key fail-closed constraints |
| --- | --- | --- |
| `treasury_buffer_policies` | Board/delegate-approved buffer policy and approved 30-day average daily outflow basis | Positive outflow; `0 < minimum < amber < target < 1`; non-empty permitted account kinds; effective date validity; corridor-currency pairing; unique corridor-policy version |
| `treasury_rebalancing_recommendations` | Evidence-backed funding recommendation; never a payment instruction | Reconciled balance and funding gap non-negative; target not below minimum; expiry after proposal; decision metadata required only for `approved` or `rejected` states |
| `treasury_stress_test_runs` | Recorded stress-test calculation or an evidence-only unavailable/stale/inconsistent result | Completed state requires every calculated output; non-completed state cannot masquerade as a numerical result |

Each create or decision transaction writes an `activity_events` record in the same PostgreSQL transaction. The recommendation evidence stores the exact policy inputs, source references, and calculation method. No table includes provider credentials, payment instructions, wallet addresses, or execution status.

## Procedure-level RBAC

| Procedure | Middleware role | Guardrails |
| --- | --- | --- |
| `treasury.proposePostgresRebalancing` | `treasury_operator` | Requires an active approved buffer policy, a reconciled balance no more than 24 hours old, non-negative evidence inputs, a future expiry, and a bounded formula. Any invalid or stale input throws; it creates no recommendation. |
| `treasury.decidePostgresRebalancing` | `admin` | Only a proposed, unexpired recommendation may be approved or rejected. The proposer cannot decide it; a decision reason is mandatory. The result is an approval record, not a transfer. |
| Read-only audit and policy evidence | `auditor` or more privileged role | No mutation ability is granted to auditors. |
| Evidence and policy compliance review | `compliance_officer` | A compliance role must review evidence through the separate compliance workflow; it has no authority to approve a treasury recommendation. |

## ZAR 50% settlement-outflow surge stress test

The ZAR policy uses a 15% minimum, 20% amber, and 25% target of the approved 30-day average daily settlement outflow. Let `D` be the approved daily ZAR settlement outflow and `A` be the current reconciled eligible ZAR available balance. Under a 50% surge, the stressed daily outflow is `1.50 × D`; therefore the stressed buffers are:

| Measure | Formula |
| --- | --- |
| Stressed minimum buffer | `0.15 × 1.50D = 0.225D` |
| Stressed amber trigger | `0.20 × 1.50D = 0.300D` |
| Stressed target buffer | `0.25 × 1.50D = 0.375D` |
| Maximum individual recommendation | `0.15 × stressed target = 0.05625D` |
| Candidate funding recommendation | `max(0, min(0.375D − A, 0.05625D, verified_near_term_funding_gap))` |

No reconciled ZAR balance, approved `D`, current policy version, or verified near-term funding gap is presently available. Consequently, UmojaFlowOS must record `input_unavailable`, `input_stale`, or `input_inconsistent` (as applicable) in `treasury_stress_test_runs` and stop. It must not substitute a hypothetical balance, recommend an amount, or create a funding instruction.

If all evidence is valid, an amount at or below `0.05625D` can be proposed only for independent administrative decision. If `A` is below `0.225D`, the policy registers a breach requiring escalation; it still does not auto-move money. This fail-closed result is intentional and preserves the provider activation boundary.
