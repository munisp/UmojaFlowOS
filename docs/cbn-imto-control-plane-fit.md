# CBN IMTO Licence Model and UmojaFlowOS Control-Plane Fit

## Licence Boundary

An **International Money Transfer Operator (IMTO)** licence is held by the authorised remittance operator. The CBN publishes licensed IMTO names through its Trade & Exchange Department, while its reforms record the licensing and operations framework for IMTOs.[^cbn-imto-list][^cbn-reforms]

UmojaFlowOS is not an IMTO, bank, authorised dealer, payment institution, custodian, FX dealer, settlement network, or regulatory filing channel. It must never hold itself out as one. A licensed IMTO remains accountable for authorised remittance scope, settlement arrangements, customer outcomes, and regulatory obligations.

## Operating Fit

| Licensed IMTO responsibility | UmojaFlowOS control-plane contribution | Explicit boundary |
|---|---|---|
| Licence, governance, and approved scope | Licence evidence, control assessment, separation-of-duties, expiry/review reminders | No licence determination or licence claim |
| Remitter and beneficiary journey | KYC/KYB evidence, consent, screening-case and exception workflow | No automated approval or remittance instruction |
| Inbound remittance and payout operating chain | Rate-lock, beneficiary, payment-order, approval, and audit controls | No payout, transfer, settlement, or FX execution without activated authorised partners |
| Reconciliation and safeguarding | Exact-money PostgreSQL calculation, immutable payment identity, ledger posture, reconciliation evidence | No TigerBeetle posting, custody, or bank/IMTO settlement without authorised activation |
| Compliance, incidents, complaints, and reporting | Case workflow, SAR/STR evidence, incident/consumer records, audit packets and report readiness | No regulator submission without authorised channel evidence |
| Bank, agent, fintech, and corridor partner relationships | Role-bound onboarding, counterparty authorisation evidence, controlled-test readiness | No verification, activation, or authority from internal evidence alone |

## Corridor Reuse

For **Nigeria (NGN)**, the controls can support a licensed CBN IMTO's governed remittance operations. For **Kenya (KES)** and **South Africa (ZAR)**, the same reusable pattern supports separately authorised remittance/payment partners subject to CBK and SARB requirements; an IMTO licence does not transfer across jurisdictions.

## Current Activation Gates

Before any live IMTO-connected flow, UmojaFlowOS requires real licensed-counterparty confirmation, approved provider credentials, authorised settlement connectivity, a configured screening/Travel Rule path where applicable, operational reconciliation evidence, security-owner approval, and a controlled test. Until then all instruction, posting, provider activation, settlement, filing, custody, and value movement paths remain fail-closed.

[^cbn-imto-list]: [Central Bank of Nigeria, *International Money Transfer Operators*](https://www.cbn.gov.ng/PaymentsSystem/InternationalMoneyTransferOperators.html).
[^cbn-reforms]: [Central Bank of Nigeria, *Reforms and Initiatives*](https://www.cbn.gov.ng/AboutCBN/Reforms.html).
