# UmojaFlowOS Treasury Operating-Buffer Recommendation

**Status:** Proposed initial operating policy — requires board or delegated risk-committee approval before activation.

## Decision and scope

This recommendation sets **configurable operational early-warning thresholds**, not statutory capital, reserve, safeguarding, or regulatory liquidity minima. It is deliberately independent of live payment, FX, settlement, banking, or stablecoin providers. UmojaFlowOS must calculate no recommendation until a policy owner has recorded the corridor’s approved exposure basis and a reconciled available balance.

| Corridor | Minimum available balance | Target available balance | Amber trigger | Maximum single recommendation | Review cadence |
| --- | ---: | ---: | ---: | ---: | --- |
| Nigeria (NGN) | 20% of approved 30-day average daily settlement outflow | 35% of the same measure | Below 25% | Lesser of 15% of target or the verified near-term funding gap | Daily monitoring; monthly calibration |
| Kenya (KES) | 20% of approved 30-day average daily settlement outflow | 30% of the same measure | Below 24% | Lesser of 15% of target or the verified near-term funding gap | Daily monitoring; monthly calibration |
| South Africa (ZAR) | 15% of approved 30-day average daily settlement outflow | 25% of the same measure | Below 20% | Lesser of 15% of target or the verified near-term funding gap | Daily monitoring; monthly calibration |

The percentages are starting operating thresholds chosen to preserve a deliberately conservative cash cushion while avoiding an unsupported claim that CBN, CBK, or SARB prescribe these exact percentages. The NGN corridor receives the largest target buffer because the initial policy should discount liquidity-source reliability and require a wider management cushion until actual settlement, funding, and stress-loss evidence supports recalibration. KES is set marginally lower, and ZAR lower still, but each corridor remains subject to the same hard controls below. These differences are **internal policy choices**, not a regulatory ranking or a statement of market liquidity.

## Calculation and non-fabrication rule

The only allowed basis is a board-approved `approved_30d_avg_daily_settlement_outflow` populated from reconciled, corridor-specific settlement history. UmojaFlowOS must retain the source period, data lineage, reconciliation timestamp, and approving policy version.

> `minimum = approved_30d_avg_daily_settlement_outflow × minimum_pct`
>
> `target = approved_30d_avg_daily_settlement_outflow × target_pct`
>
> `recommended_amount = min(target − reconciled_available_balance, max_recommendation, verified_near_term_funding_gap)`

If any input is missing, stale, unreconciled, negative, or inconsistent in currency and account scope, the workflow must fail closed and record an evidence-only exception. It must not generate a transfer instruction, route funds, select a provider, or infer values.

## Account scope and approval boundaries

Only accounts formally designated in the approved corridor policy may count toward `reconciled_available_balance`: named safeguarded/settlement accounts and named operating accounts, each recorded separately. Do not net balances across Nigeria (NGN), Kenya (KES), and South Africa (ZAR); do not include restricted, pledged, disputed, pending, unconfirmed, customer-reserved, or non-convertible balances. USDC and USDT inventory is excluded unless an approved policy explicitly defines custody, legal ownership, haircut, conversion controls, and regulatory treatment.

| Workflow step | Required role | Required evidence | Prohibited outcome |
| --- | --- | --- | --- |
| Record reconciled balance and propose a recommendation | `treasury_operator` | Account reconciliation, policy version, exposure basis, reason code | No payment or transfer initiation |
| Validate policy compliance and documentation | `compliance_officer` | Source lineage, counterparty restrictions, exception history | No self-approval of a treasury proposal |
| Approve or reject | `admin` acting under delegated treasury authority | Independent review of proposal, supporting evidence, limit check | No approval where proposer and approver are the same person |
| Execute funding or movement | External authorised process only | Provider mandate, settlement controls, maker-checker evidence | UmojaFlowOS may not execute while providers are activation-gated |

Emergency overrides require a distinct `admin` approver, a timestamped reason, expiry no longer than one business day, and retrospective compliance review. A recommendation above the maximum, an account-scope exception, or an override must escalate to the designated risk committee or board delegate outside the automated workflow.

## Regulatory grounding

CBN’s guidance requires a board-approved liquidity strategy, risk appetite and tolerance levels, early-warning indicators, limits, a contingency funding plan, cash-flow projections, and periodic review rather than a one-size-fits-all operating-buffer percentage. [1] CBN also states that limits should be established by the board and senior management and adjusted as conditions or risk tolerance change. [1] CBK’s official register shows that Kenya’s framework includes the National Payment System Act and Regulations, payment-service-provider authorisation materials, risk-management guidance, and Basel III liquidity standards. [2] SARB describes its framework as encompassing liquidity risk, structured risk assessment, key risk indicators, incident reporting, mitigation plans, and monitoring. [3]

Accordingly, the required governance model is a reviewed and evidence-backed operating policy, not a claim that these percentages meet every entity’s licensing, safeguarding, capital, or liquidity obligations. Legal and regulatory owners must reconcile the final policy to the licence type and regulator-specific permissions before activation.

## Activation criteria

The policy may be configured only after the following are supplied and approved: the legal entity and licence perimeter, designated account inventory, 30-day reconciled settlement history, currency-specific settlement calendar, approved exposure methodology, delegated approvers, and a documented contingency-funding plan. The policy must be recalibrated after any corridor expansion, material settlement incident, provider change, or evidence that forecast errors exceed the established tolerance.

## References

[1]: https://www.cbn.gov.ng/OUT/CIRCULARS/BSD/2007/GUIDELINES%20FOR%20INDIVIDUAL%20RISK%20ELEMENTS%20SEPT%202007C.PDF "Central Bank of Nigeria — Guidelines for Developing Risk Management Framework for Individual Risk Elements in Banks"
[2]: https://www.centralbank.go.ke/policy-procedures/legislation-and-guidelines/ "Central Bank of Kenya — Legislation and Guidelines"
[3]: https://www.resbank.co.za/en/home/about-us/governance/Risk_management "South African Reserve Bank — Risk Management and Compliance"
