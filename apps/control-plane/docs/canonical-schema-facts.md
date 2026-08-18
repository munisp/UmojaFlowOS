# Canonical PostgreSQL schema facts (locally verified)

Verified by direct introspection of the local canonical database `umojaflowos_dev`
on 18 August 2026. These are recorded so workflow code and regressions use the
real column and enum names rather than assumed ones.

## Enumerations

| Type | Labels |
| --- | --- |
| `rate_lock_status` | `locked`, `expired`, `cancelled` |
| `payment_status` | `draft`, `pending_policy_decision`, `blocked`, `manual_review`, `approved`, `executing`, `partially_completed`, `completed`, `failed`, `cancelled` |
| `authorization_status` | `pending_review`, `verified`, `expired`, `suspended`, `rejected` |

## `rate_locks`

`id`, `market_observation_id`, `payment_order_id`, `corridor`, `base_asset`,
`quote_asset`, `locked_rate`, `status` (`rate_lock_status`), `expires_at`,
`created_by`, `created_at`.

There is no `cancelled_by` or `expired_at` column: cancellation and expiry
attribution is carried by the immutable `activity_events` record rather than a
mutable column on the lock itself.

## `payment_legs`

`id`, `payment_order_id`, `sequence_number`, `leg_kind`, `counterparty_id`,
`status` (`payment_status`), `provider_instruction_reference`,
`provider_finality_reference`.

A leg carries provider references but no amount of its own; the amount lives on
the parent payment order. `provider_finality_reference` may only be set from a
verified provider response, so completion remains activation-gated.

## `treasury_rebalancing_recommendations`

`id`, `buffer_policy_id`, `corridor`, `currency`,
`reconciled_available_balance`, `reconciled_at`, `balance_source_reference`,
`verified_near_term_funding_gap`, `funding_gap_source_reference`,
`minimum_buffer_amount`, `target_buffer_amount`,
`computed_recommendation_amount`, `calculation_evidence`, `status`,
`proposed_by`, `proposed_at`, `decided_by`, `decided_at`, `decision_reason`,
`expires_at`.

There is deliberately no execution, transfer, or settlement column: an approved
recommendation authorises nothing by itself.
