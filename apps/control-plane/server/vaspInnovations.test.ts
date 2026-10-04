/**
 * Tests for the VASP innovation layer. The postgres pool is mocked; each
 * innovation's deterministic logic (scoring, chaining, concentration,
 * patterns, critical path, integrity, SoD, pack generation) is exercised
 * end to end against representative register states.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const poolQuery = vi.fn();
vi.mock("./postgres", () => ({ getPool: () => ({ query: poolQuery }) }));

import {
  auditVaspEvidenceIntegrity,
  canonicalJson,
  computeVaspAssuranceEvidenceChain,
  computeVaspReadinessIndex,
  detectVaspIncidentPatterns,
  evaluateVaspEvidenceStaleness,
  evaluateVaspOffshoreExposureConcentration,
  generateVaspAssurancePack,
  planVaspRegulatoryCriticalPath,
  scanVaspSodConflicts,
  scoreVaspTravelRuleRoute,
} from "./vaspInnovations";

const dossierId = "11111111-1111-4111-8111-111111111111";
const counterpartyId = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-10-05T00:00:00.000Z");
const OLD = new Date("2025-01-01T00:00:00.000Z");
const RECENT = new Date("2026-09-01T00:00:00.000Z");

const vaspDossier = { id: dossierId, track: "vasp", status: "draft" };

type Row = Record<string, unknown>;
function mockDb(handler: (sql: string, params: unknown[]) => Row[]) {
  poolQuery.mockImplementation((...args: unknown[]) => {
    const sql = typeof args[0] === "string" ? args[0] : "";
    return Promise.resolve({ rows: handler(sql, (args[1] as unknown[]) ?? []) });
  });
}

function baseHandler(overrides: Partial<Record<string, Row[]>> = {}) {
  return (sql: string): Row[] => {
    if (sql.includes("FROM cbn_sandbox_dossiers")) return [vaspDossier];
    for (const [key, rows] of Object.entries(overrides)) if (sql.includes(key)) return rows;
    return [];
  };
}

beforeEach(() => poolQuery.mockReset());

describe("canonicalJson", () => {
  it("serialises deterministically regardless of key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(canonicalJson({ a: { c: 3, d: 2 }, b: 1 }));
  });
});

describe("1 — evidence staleness monitor", () => {
  it("flags assurance evidence older than the threshold and rejected areas", async () => {
    mockDb(baseHandler({
      "evidence_recorded_at, verified_at": [
        { area: "aml_cft_cpf_operations", status: "externally_verified", evidence_recorded_at: OLD, verified_at: OLD },
        { area: "controlled_live_test", status: "rejected", evidence_recorded_at: RECENT, verified_at: null },
      ],
      "MAX(recorded_at)": [{ category: "ownership", recorded_at: OLD }],
    }));
    const report = await evaluateVaspEvidenceStaleness(dossierId, NOW);
    const codes = report.findings.map(f => f.code);
    expect(codes).toContain("ASSURANCE_EVIDENCE_STALE");
    expect(codes).toContain("AREA_REJECTED_PENDING_FRESH_EVIDENCE");
    expect(codes).toContain("DOSSIER_EVIDENCE_STALE");
    expect(report.stale).toBe(true);
  });

  it("reports fresh registers as not stale", async () => {
    mockDb(baseHandler({
      "evidence_recorded_at, verified_at": [{ area: "controlled_live_test", status: "evidence_recorded", evidence_recorded_at: RECENT, verified_at: null }],
      "MAX(recorded_at)": [{ category: "ownership", recorded_at: RECENT }],
    }));
    const report = await evaluateVaspEvidenceStaleness(dossierId, NOW);
    expect(report.stale).toBe(false);
  });
});

describe("2 — tamper-evident assurance chain", () => {
  const rows = [
    { area: "aml_cft_cpf_operations", max_points: 14, status: "open", evidence_uri: null, evidence_sha256: null, evidence_recorded_by: null, external_verifier: null, verified_by: null, updated_at: RECENT },
    { area: "controlled_live_test", max_points: 7, status: "open", evidence_uri: null, evidence_sha256: null, evidence_recorded_by: null, external_verifier: null, verified_by: null, updated_at: RECENT },
  ];
  it("is deterministic for identical register state", async () => {
    mockDb(baseHandler({ "updated_at FROM vasp_readiness_assurance_items": rows }));
    const a = await computeVaspAssuranceEvidenceChain(dossierId);
    const b = await computeVaspAssuranceEvidenceChain(dossierId);
    expect(a.headDigest).toBe(b.headDigest);
    expect(a.itemCount).toBe(2);
  });
  it("changes when any row is altered", async () => {
    mockDb(baseHandler({ "updated_at FROM vasp_readiness_assurance_items": rows }));
    const before = await computeVaspAssuranceEvidenceChain(dossierId);
    mockDb(baseHandler({ "updated_at FROM vasp_readiness_assurance_items": rows.map(r => r.area === "controlled_live_test" ? { ...r, status: "rejected" } : r) }));
    const after = await computeVaspAssuranceEvidenceChain(dossierId);
    expect(after.headDigest).not.toBe(before.headDigest);
  });
});

describe("3 — Travel Rule route scoring", () => {
  it("scores a partial record with the missing categories listed", async () => {
    mockDb(baseHandler({
      "FROM vasp_travel_rule_evidence_items": [
        { category: "originator_information_schema" }, { category: "beneficiary_information_schema" },
        { category: "secure_counterparty_exchange_design" }, { category: "counterparty_identity_and_authorisation" },
      ],
    }));
    const report = await scoreVaspTravelRuleRoute(dossierId, counterpartyId);
    expect(report.score).toBe(80);
    expect(report.band).toBe("partial_record");
    expect(report.missingCategories).toEqual(["exception_and_rejection_handling"]);
    expect(report.externalTransmission).toBe(false);
  });
  it("scores a complete internal record without claiming external verification", async () => {
    mockDb(baseHandler({
      "FROM vasp_travel_rule_evidence_items": [
        { category: "originator_information_schema" }, { category: "beneficiary_information_schema" },
        { category: "secure_counterparty_exchange_design" }, { category: "counterparty_identity_and_authorisation" },
        { category: "exception_and_rejection_handling" },
      ],
    }));
    const report = await scoreVaspTravelRuleRoute(dossierId, counterpartyId);
    expect(report.score).toBe(100);
    expect(report.band).toBe("internal_record_complete");
    expect(report.externalCounterpartyVerification).toBe(false);
  });
});

describe("4 — composite readiness index", () => {
  it("combines the three weighted components", async () => {
    mockDb(baseHandler({
      "COUNT(DISTINCT category) AS count FROM cbn_sandbox_evidence_items": [{ count: "15" }],
      "FROM vasp_regulatory_profiles": [{ id: "p1" }],
      "FROM vasp_regulatory_evidence_items WHERE profile_id": [{ count: "5" }],
      "SUM(CASE WHEN status": [{ verified: "29", total: "58" }],
    }));
    const report = await computeVaspReadinessIndex(dossierId);
    expect(report.index).toBe(62.5);
    expect(report.components).toEqual({ dossierEvidence: 100, supervisoryEvidence: 50, assuranceVerification: 50 });
  });
  it("fails closed on a non-VASP dossier", async () => {
    mockDb(() => [{ id: dossierId, track: "data_enabled_non_vasp", status: "draft" }]);
    await expect(computeVaspReadinessIndex(dossierId)).rejects.toThrow("VASP dossier");
  });
});

describe("5 — offshore exposure concentration", () => {
  it("flags prohibited_review profiles and heightened concentration", async () => {
    mockDb(baseHandler({
      "FROM vasp_offshore_counterparty_profiles": [
        { id: "p1", counterparty_id: "c1", home_jurisdiction: "KY", exposure_tier: "prohibited_review" },
        { id: "p2", counterparty_id: "c2", home_jurisdiction: "PA", exposure_tier: "heightened" },
        { id: "p3", counterparty_id: "c3", home_jurisdiction: "VG", exposure_tier: "heightened" },
        { id: "p4", counterparty_id: "c4", home_jurisdiction: "BS", exposure_tier: "heightened" },
      ],
    }));
    const report = await evaluateVaspOffshoreExposureConcentration(dossierId);
    const codes = report.breaches.map(b => b.code);
    expect(codes).toContain("PROHIBITED_REVIEW_EXPOSURE_PRESENT");
    expect(codes).toContain("HEIGHTENED_EXPOSURE_CONCENTRATION");
    expect(report.breach).toBe(true);
    expect(report.valueMovement).toBe(false);
  });
});

describe("6 — incident pattern detection", () => {
  it("detects recurring severe incidents inside the window and measures latency", async () => {
    mockDb(baseHandler({
      "FROM cbn_sandbox_incidents": [
        { kind: "fraud", severity: "high", occurred_at: new Date("2026-09-10T00:00:00Z"), detected_at: new Date("2026-09-10T06:00:00Z") },
        { kind: "fraud", severity: "critical", occurred_at: new Date("2026-09-20T00:00:00Z"), detected_at: new Date("2026-09-20T12:00:00Z") },
        { kind: "fraud", severity: "low", occurred_at: OLD, detected_at: OLD },
      ],
    }));
    const report = await detectVaspIncidentPatterns(dossierId, NOW);
    expect(report.findings.some(f => f.code === "RECURRING_SEVERE_INCIDENT_PATTERN")).toBe(true);
    expect(report.meanDetectionLatencyHours).toBe(6);
    expect(report.externalNotification).toBe(false);
  });
});

describe("7 — regulatory critical path", () => {
  it("orders overdue deadlines first and includes assurance gaps", async () => {
    mockDb(baseHandler({
      "FROM regulatory_deadlines": [
        { id: "d2", title: "Future filing", due_at: new Date("2026-12-01T00:00:00Z"), regulator: "CBN" },
        { id: "d1", title: "Overdue filing", due_at: new Date("2026-09-01T00:00:00Z"), regulator: "CBN" },
      ],
      "status IN ('open','rejected')": [{ area: "aml_cft_cpf_operations", status: "open", max_points: 14 }],
    }));
    const report = await planVaspRegulatoryCriticalPath(dossierId, NOW);
    expect(report.steps[0].reference).toBe("d1");
    expect(report.overdueCount).toBe(1);
    expect(report.steps.some(s => s.kind === "assurance_gap")).toBe(true);
    expect(report.regulatorSubmission).toBe(false);
  });
});

describe("8 — evidence integrity audit", () => {
  it("flags a digest reused across different categories", async () => {
    const digest = "a".repeat(64);
    mockDb(baseHandler({
      "FROM cbn_sandbox_evidence_items WHERE dossier_id = $1": [{ digest, label: "ownership" }],
      "FROM vasp_travel_rule_evidence_items WHERE dossier_id = $1": [{ digest, label: "originator_information_schema" }],
      "FROM vasp_readiness_assurance_items WHERE dossier_id = $1 AND evidence_sha256 IS NOT NULL": [],
    }));
    const report = await auditVaspEvidenceIntegrity(dossierId);
    expect(report.consistent).toBe(false);
    expect(report.findings.some(f => f.code === "DIGEST_REUSE_ACROSS_CATEGORIES")).toBe(true);
  });
});

describe("9 — cross-dossier SoD scanner", () => {
  it("flags verifier concentration and residual self-verification", async () => {
    mockDb((sql: string) => {
      if (sql.includes("dossier_id, verified_by")) {
        return [
          { dossier_id: "a", verified_by: "verifier-x" },
          { dossier_id: "b", verified_by: "verifier-x" },
          { dossier_id: "c", verified_by: "verifier-x" },
          { dossier_id: "d", verified_by: "verifier-y" },
        ];
      }
      if (sql.includes("evidence_recorded_by, verified_by")) {
        return [{ evidence_recorded_by: "verifier-x", verified_by: "verifier-x" }];
      }
      return [];
    });
    const report = await scanVaspSodConflicts();
    const codes = report.findings.map(f => f.code);
    expect(codes).toContain("VERIFIER_CONCENTRATION");
    expect(codes).toContain("SOD_VIOLATION_RESIDUAL");
  });
});

describe("10 — assurance pack generator", () => {
  it("produces a deterministic, explicitly internal pack", async () => {
    const handler = baseHandler({
      "external_attestation_uri, external_attestation_sha256, verified_by, verified_at FROM vasp_readiness_assurance_items": [
        { area: "controlled_live_test", max_points: 7, status: "open", evidence_uri: null, evidence_sha256: null, evidence_recorded_by: null, evidence_recorded_at: null, external_verifier: null, external_attestation_uri: null, external_attestation_sha256: null, verified_by: null, verified_at: null },
      ],
      "updated_at FROM vasp_readiness_assurance_items": [
        { area: "controlled_live_test", max_points: 7, status: "open", evidence_uri: null, evidence_sha256: null, evidence_recorded_by: null, external_verifier: null, verified_by: null, updated_at: RECENT },
      ],
      "COUNT(DISTINCT category) AS count FROM cbn_sandbox_evidence_items": [{ count: "0" }],
      "SUM(CASE WHEN status": [{ verified: "0", total: "7" }],
    });
    mockDb(handler);
    const first = await generateVaspAssurancePack(dossierId);
    const second = await generateVaspAssurancePack(dossierId);
    expect(first.packSha256).toBe(second.packSha256);
    expect(first.packSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.status).toBe("internal_only_not_submitted");
    expect(first.regulatorSubmission).toBe(false);
  });
});
