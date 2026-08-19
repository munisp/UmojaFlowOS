# Attached operating-model requirement extract

**Source:** `UmojaFlowOS—StakeholderOnboardingOperatingModel.pdf`, supplied by the user on 2026-08-19. This extract was produced with text extraction only. The supplied lifecycle image was not reopened.

## Operating principles stated by the attachment

The document describes a single auditable onboarding operating model for counterparty relationships from first contact through annual recertification. It states four governing principles: compliance-first sequencing; an independent operational and compliance reviewer for high-risk decisions; first-class Nigeria, Kenya, and South Africa country overlays; and evidence with metadata, timestamp, and approver for every gate, recertification, and change.

## Lifecycle and gates

The stated lifecycle has four phases: legal onboarding; technical integration; pilot/go-live; and steady-state. The document identifies primary gates for legal identity and ownership, documentation sufficiency, technical readiness, and pilot/go-live sign-off. Technical readiness requires UAT, rate/limit policy, and verified webhooks. Pilot sign-off requires a clean pilot period and tested service levels. Steady-state requires a recertification calendar.

The attachment states that operational controls include customer transaction caps, a compliance-maintained counterparty whitelist, settlement-window monitoring with incident handling, travel-rule payload validation, and behavioural deviation review. Its recertification triggers include licensing anniversary, beneficial-owner refresh, adverse-media sweep, sanctions re-screening, and material change in ownership, control, regulator action, or sanctions state.

## Stakeholders and stablecoin/lifecycle concerns

The document describes enterprise customers, liquidity providers and market makers, banking/payment rails, stablecoin issuers/custodians, compliance/risk vendors, auditors/regulators, and internal operations functions. It calls for verification of supported stablecoins, chains, and settlement pairs; custody account and issuer mint/redemption service levels; liquidity/quote evidence; travel-rule evidence; sanctions and AML controls; and a bounded pilot before steady-state activation.

## Audit implications

The lifecycle review must distinguish an implemented technical boundary from a live provider relationship. A provider, stablecoin issuer, market maker, or payment rail cannot be represented as onboarded, activated, or settlement-capable until authorised counterparty, credential, licence, technical-readiness, and pilot evidence exist.
