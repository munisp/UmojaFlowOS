# VASP Implementation Audit — Robustness, Integration, Gaps — 2026-10-04

Branch: `audit-remittance-bdc-antiwipe-performance-2026-09-24`

## Verdict

The VASP surface is **architecturally robust and genuinely integrated**: real
PostgreSQL state (migrations 0035/0036/0040 — 9 tables with strict CHECK
invariants and append-only evidence), transactional server modules with
activity-evidence on every mutation, role-gated tRPC procedures, UI surfaces
in the CBN sandbox workspace, fail-closed Go/Rust/Python evaluators with all
external-authority fields hard-coded false, and a CI evidence gate. It is a
readiness/evidence control plane by deliberate design — it does not and must
not execute regulated activity.

## What was verified real (not mocked)

| Layer | Evidence |
|---|---|
| Schema | 0035 (profiles, supervisory + Travel Rule evidence, route assessments with `external_* = false` CHECKs), 0036 (offshore counterparty exposure), 0040 (58-point assurance register with per-status row invariants, incl. `verified_by <> evidence_recorded_by` SoD at the DB level) |
| Server | `vaspReadiness.ts`, `vaspReadinessAssurance.ts` — BEGIN/COMMIT transactions, FOR KEY SHARE/UPDATE locking, idempotent ON CONFLICT, immutable activity events |
| Router | 23 VASP/readiness procedures across RBAC classes (public, auditor, admin, compliance, assuranceVerifier) |
| Cross-language | Go `vaspcontrol.Evaluate` (+2 tests), Rust `assess_vasp_readiness` (+test), Python `summarize_vasp_readiness` — all fail-closed, all authority flags false |
| CI | `vasp-readiness-evidence-gate.yml` + `evidence-kit/` validators (owner assignments, manifest, placeholder rejection, schema validation) |
| UI | `CbnSandboxWorkspace` (dossiers, evidence, assurance register, Travel Rule assessment), `OperationsCoverageWorkspace` (offshore counterparty), `RouterCoverageWorkspace` (all procedures) |

## Gaps found and fixed in this wave

| # | Gap | Severity | Fix |
|---|---|---|---|
| 1 | `rejectReadinessAssuranceEvidence` procedure existed server-side but had **no UI action** — the open → evidence_recorded → externally_verified/rejected lifecycle could not be completed in the workspace | Medium (integration) | Reject button + rejection form added to `CbnSandboxWorkspace` assurance panel (verifier roles only, ≥20-char rationale, honest no-external-claim copy) |
| 2 | Evidence-kit validators ran **only against declared files in CI**; nothing checked declarations against the live PostgreSQL register (drift, submitter/verifier mismatch, attestation-without-verification were undetectable from the platform) | High (integration) | New `vaspEvidenceKitValidation.ts` + 2 auditor procedures (`validateVaspOwnerAssignments`, `validateVaspEvidenceManifest`): area coverage, fixed points/roles, placeholder rejection, SoD, live submitter/verifier agreement, URI/sha256 agreement, attestation/status consistency — read-only, fail-closed on non-VASP dossiers |
| 3 | Validator placeholder regex initially matched legitimate emails (`EXAMPLE` ⊂ `example.com`) | Low (found by the new tests) | Regex corrected to word-boundary tokens; regression covered by the "accepts complete assignment set" test |

Mock/stub sweep across all 31 VASP-related files: the only matches are
**test mocks** (`vaspReadinessAssurance.test.ts` pool mock — correct),
**anti-placeholder validators** (schemas/CI scripts whose job is to reject
placeholders), and template instructions. No production mock or stub exists.

## Honest boundaries (unchanged, by design)

- Evidence sha256 digests are **declared references** to externally stored
  documents; the platform stores and cross-checks them but does not fetch
  remote evidence content (that would require approved external connectivity).
- No Travel Rule transmission, custody, value movement, licence claim, or
  regulator submission — enforced at schema (CHECK false), contract (all
  flags false), and copy levels.
- Native `compliance/vasp/**` assignment/manifest files are CI inputs the
  operator must supply; the workflow correctly no-ops without them.

## Test evidence

- `vaspEvidenceKitValidation.test.ts`: **8/8 pass** (complete-accept, SoD
  violation, placeholder+missing-area+uninitialised register, submitter
  mismatch, digest mismatch, attestation-without-verification, malformed
  digest/non-HTTPS, non-VASP dossier fail-closed).
- `vaspReadinessAssurance.test.ts`: **5/5 pass** (no regression).
- `tsc` transpile checks: `routers.ts`, `vaspEvidenceKitValidation.ts`,
  `CbnSandboxWorkspace.tsx`, `RouterCoverageWorkspace.tsx` — all syntax-clean.
- Procedure count: 279 → **281** (two new auditor queries); both registered
  in `RouterCoverageWorkspace` so the 281/281 UI-coverage invariant holds.
