# ZAR Settlement-Outflow Surge Stress Test (50 percent)

## Purpose and scope

This document records the deterministic settlement-outflow surge stress test for the South Africa (ZAR) corridor, its executed result against the current canonical PostgreSQL state, and the exact fail-closed rules that govern it. The evaluation is advisory only: it derives stressed buffer thresholds and a bounded rebalancing recommendation, and it never initiates, authorises, or implies a transfer.

## Implementation boundary

The evaluator lives in the Rust risk and compliance core, consistent with the platform's language assignment for risk logic, at `services/risk-compliance-core/src/treasury_stress.rs`. It is a pure function over an approved buffer policy, a scenario multiplier, and an optional reconciled balance observation. Input assembly is deliberately separated from evaluation: `scripts/treasury/export-stress-inputs.sh` reads only configured canonical records, and `stress-test-runner` performs the evaluation and prints an evidence record.

## Fail-closed rules

The evaluator refuses to produce numbers whenever the inputs cannot support them. Every refusal is classified, carries a reason code, and leaves all numeric fields null, so no downstream record can suggest a computation that did not occur.

| Condition | Classification | Reason code |
| --- | --- | --- |
| Scenario multiplier is not finite or is below 1.0 | `input_inconsistent` | `SCENARIO_MULTIPLIER_INVALID` |
| Buffer policy fractions are out of range or not ordered minimum ≤ amber ≤ target | `input_inconsistent` | `BUFFER_POLICY_INCONSISTENT` |
| No reconciled balance observation is supplied | `input_unavailable` | `RECONCILED_BALANCE_UNAVAILABLE` |
| Reconciled balance carries no source reference | `input_inconsistent` | `RECONCILED_BALANCE_UNSOURCED` |
| Reconciled balance is not a finite non-negative amount | `input_inconsistent` | `RECONCILED_BALANCE_INVALID` |
| Reconciled balance is older than 24 hours | `input_stale` | `RECONCILED_BALANCE_STALE` |

## Deterministic derivation

When every input is present, sourced, current, and internally consistent, the stressed thresholds follow arithmetically from the approved policy. Nothing is estimated:

> stressed daily outflow = approved daily outflow × outflow multiplier
> stressed minimum buffer = stressed daily outflow × minimum buffer percentage
> stressed amber buffer = stressed daily outflow × amber buffer percentage
> stressed target buffer = stressed daily outflow × target buffer percentage
> shortfall to target = max(0, stressed target buffer − reconciled available balance)
> recommendation = min(shortfall to target, stressed target buffer × maximum recommendation percentage)

The recommendation is therefore bounded twice: it can never exceed the actual shortfall, and it can never exceed the single-recommendation ceiling defined by the approved policy. A breach of the stressed minimum buffer is reported as a separate boolean and reason code rather than being folded into the amount, so a reviewer can distinguish severity from size.

## Executed run against current canonical state

The input exporter was executed against the canonical local PostgreSQL database on the date of this record:

```
$ ./scripts/treasury/export-stress-inputs.sh
No approved, currently effective ZAR buffer policy exists in the canonical schema.
The stress test cannot be run: fail closed with no invented policy inputs.
exit=4
```

This is the correct and expected outcome. The canonical schema currently holds no approved ZAR buffer policy and no reconciled ZAR liquidity position, because no authorised treasury source has been connected and no operational data has been fabricated. The exporter therefore refuses to construct an input document at all, and the stress test does not run.

To demonstrate that the evaluation path itself is complete and reachable rather than merely declared, the runner was additionally executed with a policy-shaped document that carried an explicitly unapproved policy version and no balance. The runner classified the run `input_unavailable` with reason code `RECONCILED_BALANCE_UNAVAILABLE`, returned null for every numeric field, reported `authorises_execution: false`, and exited with status 3 to distinguish a fail-closed classification from a completed computation. That temporary document was deleted immediately afterwards and no record was written to PostgreSQL.

## Regression coverage

Eight unit tests in `services/risk-compliance-core/src/treasury_stress.rs` pass and cover: absence of a balance, staleness, unsourced provenance, inconsistent policy ordering, an invalid multiplier, the exact deterministic threshold and capped-recommendation arithmetic for a 50 percent surge, the zero-recommendation case when the stressed target is already held, and a serialisation guard asserting the outcome payload contains no execution, transfer, settlement, or instruction field.

## Prerequisites for a live run

A completed, decision-grade run requires three inputs that must originate outside this repository: an approved and currently effective ZAR buffer policy record including its approving authority and source period, a reconciled ZAR liquidity position no older than 24 hours carrying an authorised source reference, and a treasury operator acting under the platform's role separation. Until those exist, this scenario will continue to fail closed by design.
