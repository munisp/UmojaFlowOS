## Change summary

Describe the operational change and affected corridors: Nigeria (NGN), Kenya (KES), South Africa (ZAR), or shared controls.

## Regulatory and operational impact

State whether the change affects CBN, CBK, SARB, Travel Rule, sanctions screening, USDC, USDT, ledger behavior, or provider authorization. Link the approved control or explicitly state that no activation behavior changes.

## Evidence

- [ ] Tests and contract checks pass.
- [ ] No production secret, customer data, payment data, sanctions-list snapshot, or report submission is committed.
- [ ] Database migration is forward-only and has an approved rollback plan when applicable.
- [ ] Provider integration behavior is gated by verified authorization and secret health checks.
