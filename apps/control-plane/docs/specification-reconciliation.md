# Specification Reconciliation

This document reconciles the implementation ledger against the two uploaded
specifications: the enterprise architecture document and the Nigeria, Kenya,
and South Africa stablecoin and cross-border payments regulatory review. It
restates the sixteen extracted requirements from
`docs/requirements-traceability.md` and records, for each, what exists in code
today and what does not. The traceability matrix records what each requirement
*is*; this document records where each requirement now *stands*.

A requirement is recorded in one of three states. **Implemented** means the
behaviour exists in code and is covered by a regression that fails when the
behaviour is removed. **Activation-gated** means the non-provider portion is
implemented and the remainder cannot be built without credentials, licensed
counterparties, or infrastructure that has not been supplied; these are legal
and safety boundaries, not deferred work. **Gap** means something the
specification requires that is neither implemented nor gated by an external
dependency.

## Requirement-by-requirement status

| Ref | Requirement, abbreviated | State | Evidence or reason |
| --- | --- | --- | --- |
| RQ-01 | Multi-corridor orchestration across NGN, KES, ZAR with state tracking and audit trail | Activation-gated | Canonical payment order and leg lifecycles, corridor enums, and an immutable audit trail are implemented in Go and PostgreSQL with lifecycle regressions. Execution requires an authorised provider, which is refused rather than simulated. |
| RQ-02 | Orchestrator/regulated-provider separation; money-bearing execution stays with licensed entities | Implemented | `assertNoExecutionAuthority` walks every service payload and rejects execution-shaped and credential-shaped keys at any depth; no contract can express a settlement instruction. |
| RQ-03 | Atomic debit-and-credit semantics; projections separate from monetary truth | Implemented | The Rust ledger gateway validates postings by re-deriving the balance independently, and projection reconciliation re-verifies TigerBeetle-to-PostgreSQL agreement rather than trusting the gateway's own flags. TigerBeetle itself remains activation-gated. |
| RQ-04 | Quotes with validity windows, fee breakdowns, idempotent writes, acceptance-to-order conversion | Activation-gated | Rate locks with binding expiry, single-use consumption bound to an order in one transaction, and idempotent replay rejection are implemented. A lock requires a market observation, which requires an active FX integration. |
| RQ-05 | Treasury and liquidity management with buffers and rebalancing | Implemented | Buffer policy evaluation, fail-closed `input_unavailable` handling, the separation-of-duties rebalancing workflow, and the deterministic ZAR 50% surge stress test. No transfer is ever initiated. |
| RQ-06 | FX and stablecoin operations for USDC and USDT | Activation-gated | Source-derived spread requiring at least two independent recorded sources, and USDC/USDT exposure reporting in Python. No rate or peg is displayed without a verified observation. |
| RQ-07 | Pre-execution compliance: sanctions, KYC/KYB, Travel Rule, policy gates, cases, monitoring | Activation-gated | Six deterministic Rust monitoring rules, counterparty risk banding, the compliance case lifecycle, alert workflow, and evidence-only KYC/KYB are implemented. Sanctions list ingestion requires authorised sources. |
| RQ-08 | Sanctions coverage: OFAC, UN, EU | Activation-gated | No list is ingested and none is simulated. Screening state exists as an explicit unverified state rather than a fabricated clear. |
| RQ-09 | Corridor-specific CBN, CBK, SARB reporting with submission audit evidence | Activation-gated | The full report lifecycle is implemented: entity-bound drafting, review requiring artifact and manifest, compliance-officer-only approval separate from the preparer, and refusal of `submitted` without an authorised channel reference. Submission itself requires a channel. |
| RQ-10 | Licensed PSP, correspondent-bank, and stablecoin-provider registry with counterparty risk | Implemented | Counterparty registry, licence-evidence authorisations with a lifecycle, and additive risk banding in which a suspended licence is prohibitive. |
| RQ-11 | Counterparty risk and velocity checks | Implemented | Rust counterparty risk banding and the velocity rules within the six monitoring rules, with 34 tests in the risk crate. |
| RQ-12 | Fixed language ownership: Go, Rust, Python, TypeScript | Implemented | Enforced mechanically. The runtime-alignment guard forbids any language service from declaring or importing a database client, verified with a negative control, and the four live bridge suites drive the real binaries. |
| RQ-13 | Four roles with procedure-level enforcement and activity logging | Implemented | 90 role-gated procedures, the documented role-authority matrix, the router access-control red team with a negative control, and attributable activity events on every mutation. |
| RQ-14 | Alerts for liquidity thresholds, failed payments, compliance flags, regulatory deadlines | Implemented | All four evaluators exist on canonical PostgreSQL with row locking, deduplication, verbatim evidence, and an acknowledge-and-escalate lifecycle. Corridors lacking policy or a fresh position are reported indeterminate rather than healthy. |
| RQ-15 | International Typographic Style; no fabricated dashboard data | Implemented | The console renders real zero states rather than sample figures, recorded in the dated visual reviews, and accessibility is now measured by an axe-core audit over eleven surfaces. |
| RQ-16 | No provider represented as active without approved credentials | Implemented | The activation boundary is displayed to the operator, the service bridge is disabled by default with no localhost fallback, and no code path activates an integration. |

## Named gaps

Reconciliation found no requirement in the **Gap** state. Every extracted
requirement is either implemented with a failing-capable regression or
activation-gated behind an external dependency that has not been supplied.

Two limitations are worth stating plainly, because neither is a provider gate
and both would otherwise look like silent omissions.

The first is host capacity. The evidence-only Ollama validation cannot execute
here: both 8B models exceed the sandbox memory ceiling, with roughly 2 GB
available against a 5.8 GB weight blob. The validator and its assertions are
implemented and committed; only the execution is blocked, and the measurements
are recorded in `docs/private-ollama-verification.md`.

The second is the transitional source. The MySQL/TiDB cutover executor is
implemented, dependency-ordered, and reconciled against the real target schema,
but the transitional source currently holds one user row and zero business
rows. Non-empty business-row reconciliation therefore has no data to exercise,
and the executor blocks rather than silently skipping any non-empty table it
does not map.

## Regulatory specification

The regulatory review is reflected as enforced structure rather than as prose.
Nigeria, Kenya, and South Africa appear as fixed corridor enumerations; CBN,
CBK, and SARB appear as fixed regulator enumerations with a supervision pairing
that the report contract verifies rather than accepts; USDC and USDT are the
only stablecoins the exposure reporting recognises. No jurisdiction-specific
legal threshold is asserted as fact anywhere in the code, because none was
supplied by a primary source; where a threshold would be required, the relevant
evaluator reports an explicit indeterminate state instead of assuming one.
