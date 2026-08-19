# Visual Validation Record

## 2026-08-17 operator-console review

The authenticated desktop console rendered the International Typographic Style system as specified: a white and near-white canvas, strict black rules, bold black sans-serif typography, red square module markers, and a red active-navigation treatment. The overview, payment-orchestration, and counterparty-registry routes displayed real zero-state records rather than fabricated operational figures.

The mobile review at 375×812 rendered a compact top bar, readable module title treatment, single-column metrics, and intact activation-boundary and payment-intake content. The navigation remained reachable from the mobile sidebar trigger. No text clipping, contrast failure, or horizontal overflow was observed in the inspected routes.

The console explicitly communicates that payments, market observations, and regulatory submissions are unavailable until verified provider evidence exists. This statement is intentional and reflects the source-honest implementation boundary.

## 2026-08-17 rate-lock workflow review

The FX and stablecoin module was revalidated after adding the source-derived rate-lock workflow. The console presented separate observable actions for evidence ingestion and locking without overflow in the narrow action panel. The empty state accurately stated that a persisted source observation and a future expiry are required before a lock can exist. No FX rate, USDC peg, or USDT peg value was rendered in the absence of a verified provider observation.

## 2026-08-17 payment-leg workflow review

The payment-orchestration module was reviewed after payment-leg controls were added. Draft, leg, customer, and beneficiary actions remained visible within the constrained action panel. The payment-order and payment-leg ledgers each rendered a distinct, source-honest empty state, and the screen continued to state that execution remains unavailable pending verified policy, counterparty, and provider controls.

## 2026-08-17 regulatory-deadline and alert review

The CBN, CBK, and SARB reporting module displayed separate report and deadline actions with a readable source-honest deadline register. The alert module displayed policy creation and a protected evaluation action without claiming a scheduled job is active before deployment. Both action panels remained legible at the desktop viewport and their empty states did not introduce regulatory, payment, or notification data.

## 2026-08-17 counterparty licence-evidence review

The counterparty registry was reviewed after adding separate licence-evidence controls. The administrator view presented independent counterparty and licence actions, a counterparty register, and an authorisation-evidence register. The layout remained legible at the desktop viewport, and both empty states accurately represented the absence of persisted operational data rather than fabricated provider or licence records.

## 2026-08-18 PostgreSQL cutover-readiness review

The overview displayed the live local PostgreSQL schema assessment as a separate activation-boundary item. The text correctly identified that 23 canonical tables were locally validated and explicitly stated that production deployment and service cutover remain separate gates. No production database, provider, payment, or submission capability was inferred from the local development result.

## 2026-08-18 KYC and KYB document-free workflow review

The compliance console was reviewed after adding the PostgreSQL-backed KYC and KYB evidence workflow. The layout presented a distinct authorised-document boundary, a reviewer-decision area, and a separate analysis-job ledger alongside existing compliance cases. Its zero state accurately states that no document, identity, business, or model result is manufactured in the absence of authorised material. The local Qwen3-VL development runtime is described as document-gated and evidence-only; the screen does not imply automated approval, rejection, or live provider activation.

The completed review also confirmed separate panels for persisted analysis evidence and manual reviewer-decision history. Both render explicit zero states when no consent-backed evidence or human decision exists. This preserves the distinction among unavailable visual analysis, review-required evidence, and an attributable compliance-officer decision.

## 2026-08-19 mechanical accessibility audit

Visual review by inspection cannot establish accessibility, so the console is now audited by the axe-core rule engine against the rendered DOM rather than by description. `client/src/components/consoleAccessibility.test.tsx` audits eleven operator surfaces: the customer onboarding, regulatory deadline, SAR/STR filing, report draft, report transition, KYC document upload, rate lock, and payment order forms, together with the KYC document review table, the compliance case disposition controls, and the withheld treasury proposal state. All eleven report zero violations.

The audit is verified to be capable of failing rather than merely passing. Unwrapping a single label in the customer onboarding form so its input loses its accessible name produces a critical `label` violation naming the exact element, and the suite fails. A permanently included negative control asserts the same property on a deliberately unlabelled input, so the audit cannot silently degrade into a vacuous pass.

Two rules are scoped deliberately, and neither lowers the standard. Colour contrast is disabled because jsdom does not compute rendered colours, so the rule cannot evaluate anything meaningful there; contrast is covered by the viewport reviews recorded above. The page-level `region` rule requires all content to sit within a landmark, which is a property of the assembled page rather than of an isolated fragment, so each surface is rendered inside a `main` landmark exactly as the real console provides. Every other rule runs unmodified.
