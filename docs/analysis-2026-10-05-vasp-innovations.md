# VASP Innovation Layer — Ten Analytical Capabilities — 2026-10-05

Branch: `audit-remittance-bdc-antiwipe-performance-2026-09-24`

Module: `apps/control-plane/server/vaspInnovations.ts`
Tests: `apps/control-plane/server/vaspInnovations.test.ts` — **15/15 pass**

All ten capabilities are **read-only auditor queries** over the recorded
PostgreSQL register state. Every one is fail-closed (a non-VASP or missing
dossier throws rather than guessing) and every report carries explicit
`externalAuthority: false` / `regulatorSubmission: false` markers. Nothing in
this layer contacts, verifies, transmits to, or submits to any external party.

## The ten innovations

| # | Capability | Procedure | What it adds |
|---|---|---|---|
| 1 | **Evidence staleness monitor** | `vaspEvidenceStaleness` | Flags assurance or dossier evidence untouched for > 180 days, and rejected areas awaiting fresh evidence — stale evidence silently looked current before |
| 2 | **Tamper-evident assurance chain** | `vaspAssuranceEvidenceChain` | Deterministic sha256 hash chain over canonical assurance-register rows; any register alteration between reviews changes the head digest |
| 3 | **Travel Rule route scoring** | `vaspTravelRuleRouteScore` | Per-route completeness score (0–100) across the 5 Travel Rule categories with explicit `externalCounterpartyVerification: false` / `externalTransmission: false` |
| 4 | **Composite readiness index** | `vaspReadinessIndex` | Single weighted 0–100 internal index (dossier evidence 25%, supervisory evidence 35%, assurance verification 40%) with full component breakdown |
| 5 | **Offshore exposure concentration check** | `vaspOffshoreExposureConcentration` | Enforces internal policy ceilings: any `prohibited_review` profile or > 2 `heightened` exposures is a breach; per-profile missing-category map included |
| 6 | **Incident pattern detection** | `vaspIncidentPatterns` | Detects ≥ 2 high/critical incidents of the same kind within a trailing 90-day window; reports mean detection latency (occurred → detected); advisory only |
| 7 | **Regulatory critical-path planner** | `planVaspRegulatoryCriticalPath` | Merges open CBN deadlines with open/rejected assurance areas into one ranked plan; overdue items surface first |
| 8 | **Evidence digest integrity audit** | `vaspEvidenceIntegrityAudit` | Cross-table scan (dossier / Travel Rule / assurance / supervisory evidence) for the same sha256 digest attached to different categories — a classic copy-paste evidence defect |
| 9 | **Cross-dossier SoD scanner** | `vaspSodConflictScan` | Global scan for verifier concentration (> 2/3 of all verifications by one subject across ≥ 3 items) and residual self-verification that would indicate a schema bypass |
| 10 | **Deterministic assurance pack** | `vaspAssurancePack` | Board/audit-ready canonical JSON snapshot (register + readiness index + chain head) with a stable `packSha256`; status is always `internal_only_not_submitted` |

## Design constraints honoured

- **No schema changes** — all ten read existing tables; no migration, no
  write path, no new privilege surface.
- **RBAC** — every procedure is `auditorProcedure` (readable by admin,
  compliance, treasury, auditor); read-only analytics carry no write risk.
- **Honesty invariants** — scoring and packing never mutate readiness state,
  and every response restates that no external authority is implied.
- **Determinism** — `canonicalJson` (sorted-key serialization) underpins the
  chain and pack digests, so identical register state always yields identical
  digests (verified by test).

## Test evidence

- `vaspInnovations.test.ts`: **15/15 pass** — canonicalJson determinism;
  staleness flag + clean register; chain determinism + tamper sensitivity;
  route scoring 80/100 + complete band; index weighting (62.5 composite);
  fail-closed non-VASP rejection; prohibited/heightened concentration
  breaches; recurring-incident detection + latency; overdue-first critical
  path; digest-reuse detection; verifier concentration + residual SoD;
  pack determinism + internal-only status.
- `tsc` transpile checks clean on `vaspInnovations.ts`,
  `vaspInnovations.test.ts`, `routers.ts`, `RouterCoverageWorkspace.tsx`.
- Procedure count: 281 → **291**; all ten registered in
  `RouterCoverageWorkspace`, preserving the UI-coverage invariant.

## Honest boundaries

- Staleness, pattern, and concentration outputs are **advisory findings**;
  they neither auto-reject evidence nor notify any authority.
- The 180-day staleness window, 90-day incident window, and 2/3 verifier
  ceiling are internal policy constants documented in code; regulators set
  their own thresholds.
- Pack digests prove register-state integrity between two platform reads;
  they do not prove the underlying external documents' contents.
