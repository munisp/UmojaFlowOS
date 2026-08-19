# Multi-Language Service Contracts

UmojaFlowOS runs four languages by design, each owning the domain it is best
suited to. The control plane must therefore consume output from three external
runtimes without ever trusting them blindly. This document records the contract
strategy that governs those boundaries, and the invariants enforced in code at
`server/contracts/`.

## Ownership boundaries

| Producing service | Language | Owns | Emits to the control plane |
| --- | --- | --- | --- |
| `umojaflowos-payment-engine` | Go | Corridor payment order lifecycle and its immutable audit chain | `umojaflowos.payment.order.validated.v1`, `umojaflowos.payment.audit_trail.v1` |
| `umojaflowos-risk-compliance-core` | Rust | Policy decisions, transaction monitoring rules, counterparty risk banding, treasury stress evaluation | `umojaflowos.policy.decision.v1`, `umojaflowos.risk.monitoring_result.v1`, `umojaflowos.risk.counterparty_assessment.v1` |
| `umojaflowos-reporting-analytics` | Python | CBN/CBK/SARB report assembly, USDC and USDT exposure reporting, lakehouse batch manifests | `umojaflowos.reporting.assembled_report.v1`, `umojaflowos.reporting.stablecoin_exposure.v1`, bronze batch manifests |
| control plane | TypeScript | Canonical PostgreSQL system of record, RBAC, operator interface | — (consumer, never a producer of these envelopes) |

## Versioning rule

Every envelope carries `service` and `contract_version`. The version is part of
the envelope type string as well (`...v1`), so a producer cannot change a payload
shape without also changing the type it declares. Schemas are `.strict()`: an
unrecognised field is rejected rather than ignored. This is deliberate. A silently
ignored field is the mechanism by which an execution instruction, a provider
credential, or an unreviewed automated decision could enter the system unnoticed.

When a producer needs a breaking change it introduces `...v2` alongside `v1`; the
control plane adds a parser for the new version and retains the old one until no
producer emits it. There is no in-place mutation of a released contract.

## Enforced invariants

These are checked in `server/contracts/services.ts`, not merely documented:

1. **No execution authority.** `assertNoExecutionAuthority` walks the payload to
   any depth and rejects `execute`, `settle`, `submit`, `file_report`, `transfer`,
   and their `_instruction` variants, plus `credential`, `api_key`, and
   `provider_credential`. No service output can instruct the control plane to move
   value or file with a regulator, and no service output may carry a credential.
2. **Missing evidence fails closed.** A Rust monitoring result that reports an
   `INPUT_UNAVAILABLE_*` finding cannot claim `ALLOW`. The Rust core already
   guarantees this; re-checking at the boundary means a regression in either
   language is caught rather than trusted.
3. **Undetermined and prohibited risk always require review.** An undetermined
   band must also state which evidence was missing, so "unknown" is never
   presentable as "clear".
4. **Audit chains verify, not just validate.** A Go audit trail is checked for
   contiguous sequence numbering and hash linkage, so a removed or reordered
   event is rejected even though it would satisfy the schema.
5. **Regulator and corridor must agree.** A CBN return cannot describe the Kenyan
   or South African corridor, which would otherwise be a silently mis-filed report.
6. **Assembly is never submission.** An assembled report may only declare
   `assembled_pending_review`. Submitted status is recorded exclusively by the
   control plane, and only against a verified channel reference.
7. **Stablecoin scope is fixed.** Exposure lines accept USDC and USDT only, and
   every line must carry at least one reconciled source reference.

## Activation gating

Parsing an envelope is provider-independent and always available. Acting on one
is not. The parsers are exposed through compliance-gated procedures so an
auditor cannot invoke them, and nothing in this layer can initiate a payment, an
FX conversion, a screening call, or a regulatory submission. Those paths remain
blocked until authorised provider credentials are supplied and a policy decision
is recorded, which is enforced separately in the payment and reporting workflows.

## Deployment alignment

All three services are PostgreSQL-first consumers in the same sense as the
control plane: they compute over supplied reconciled inputs and return evidence,
while the canonical PostgreSQL instance remains the single system of record. None
of them holds its own authoritative store, so there is no second source of truth
to reconcile. Their runtime configuration follows the same activation-contract
pattern as the middleware templates under `infra/`, with transport security and
secret indirection required before any non-loopback endpoint is accepted.

## Live cross-language verification

A schema on one side and unit tests on the other cannot prove that two languages
agree on a wire format. Three opt-in regressions therefore start the real service
processes and drive them through the actual bridge and the actual parsers:

| Regression | Runtime started | Opt-in flag |
| --- | --- | --- |
| `server/goServiceBridge.live.test.ts` | compiled Go payment engine | `GO_SERVICE_LIVE_TEST=1` |
| `server/rustServiceBridge.live.test.ts` | compiled Rust risk core | `RUST_SERVICE_LIVE_TEST=1` |
| `server/pythonServiceBridge.live.test.ts` | FastAPI reporting app under uvicorn | `PYTHON_SERVICE_LIVE_TEST=1` |

Each is skipped, never silently passed, when its toolchain or service directory is
absent, so a missing runtime cannot be mistaken for evidence. Together they assert
the contract-valid success path for every route the bridge calls, the
regulator-to-corridor pairing, artifact-digest stability when a caller reorders
inputs, and that a refusing or unreachable service yields `unavailable` with no
`ALLOW` or `APPROVED` anywhere in the response.

Introducing them surfaced three real defects that every existing test had missed.
Each would have silently disabled a capability in production while both sides
appeared healthy in isolation:

| Defect | Consequence | Resolution |
| --- | --- | --- |
| The Rust `monitoring` and `counterparty_risk` modules were never declared in `lib.rs` | Both compiled nowhere, so their tests never ran and the two routes the bridge calls did not exist; the bridge would have reported `unavailable` indefinitely | Declared both modules and added the routes; the Rust suite rose from 13 to 34 tests |
| The Python assembly and exposure endpoints returned ad-hoc bodies such as `{"report": ...}` | The strict parser rejects unknown keys, so every response would have been discarded as contract drift | Both endpoints now emit the published envelopes using canonical corridor identifiers |
| The Go validate route returned a bare `{status, provider_execution}` object | Same outcome: the versioned event parser would have refused it | The route now returns the published validated-event envelope with independent event and correlation identifiers |
