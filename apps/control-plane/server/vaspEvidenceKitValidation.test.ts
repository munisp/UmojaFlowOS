/**
 * Tests for the server-side VASP evidence-kit consistency checks.
 * The postgres pool is mocked; the validators' own logic (fixed register,
 * SoD, placeholder rejection, digest/URI agreement) is exercised end to end.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQuery = vi.fn();
vi.mock("./postgres", () => ({ getPool: () => ({ query: poolQuery }) }));

import { validateVaspEvidenceManifestAgainstRegister, validateVaspOwnerAssignmentsAgainstRegister } from "./vaspEvidenceKitValidation";

const dossierId = "11111111-1111-4111-8111-111111111111";

const OWNER_ROWS = [
  { area: "controlled_live_test", points: 7, role: "product_and_risk_owner" },
  { area: "governance_legal_ownership", points: 8, role: "board_legal_company_secretary" },
  { area: "aml_cft_cpf_operations", points: 14, role: "mlro_compliance_owner" },
  { area: "customer_asset_safeguarding", points: 13, role: "custody_treasury_owner" },
  { area: "cybersecurity_resilience", points: 10, role: "ciso_platform_sre_owner" },
  { area: "consumer_incident_reporting", points: 6, role: "consumer_protection_cbn_liaison" },
] as const;

function assignments(overrides: Partial<(typeof OWNER_ROWS)[number]> = {}, area = "controlled_live_test") {
  return OWNER_ROWS.map(row => ({
    area: row.area,
    points: row.points,
    accountableRole: row.role,
    externalEvidenceOwner: "Ada Lovelace",
    externalContact: "owner@example.com",
    platformSubmitterSubject: "submitter-1",
    platformVerifierSubject: "verifier-1",
    ...(row.area === area ? overrides : {}),
  }));
}

const liveRow = {
  area: "controlled_live_test",
  max_points: 7,
  accountable_owner_role: "product_and_risk_owner",
  status: "open",
  evidence_uri: null,
  evidence_sha256: null,
  evidence_recorded_by: null,
  external_attestation_uri: null,
  external_attestation_sha256: null,
  verified_by: null,
};

function mockDb(items: unknown[] = [liveRow]) {
  poolQuery.mockImplementation((...args: unknown[]) => {
    const sql = typeof args[0] === "string" ? args[0] : "";
    if (sql.includes("cbn_sandbox_dossiers")) return Promise.resolve({ rows: [{ id: dossierId }] });
    return Promise.resolve({ rows: items });
  });
}

describe("vasp evidence-kit register consistency", () => {
  beforeEach(() => poolQuery.mockReset());

  it("accepts a complete, segregated, register-matching owner assignment set", async () => {
    mockDb(OWNER_ROWS.map(row => ({ ...liveRow, area: row.area, max_points: row.points, accountable_owner_role: row.role })));
    const report = await validateVaspOwnerAssignmentsAgainstRegister(dossierId, assignments());
    expect(report.consistent).toBe(true);
    expect(report.findings).toEqual([]);
    expect(report.externalAuthority).toBe(false);
  });

  it("rejects self-review (submitter equals verifier)", async () => {
    mockDb(OWNER_ROWS.map(row => ({ ...liveRow, area: row.area, max_points: row.points, accountable_owner_role: row.role })));
    const report = await validateVaspOwnerAssignmentsAgainstRegister(dossierId, assignments({ platformVerifierSubject: "submitter-1" }));
    expect(report.consistent).toBe(false);
    expect(report.findings.some(f => f.code === "SOD_VIOLATION")).toBe(true);
  });

  it("rejects placeholder values and missing areas", async () => {
    mockDb();
    const bad = assignments({ externalEvidenceOwner: "REPLACE_WITH" }).filter(row => row.area !== "consumer_incident_reporting");
    const report = await validateVaspOwnerAssignmentsAgainstRegister(dossierId, bad);
    const codes = report.findings.map(f => f.code);
    expect(codes).toContain("PLACEHOLDER_VALUE");
    expect(codes).toContain("AREA_MISSING");
    expect(codes).toContain("REGISTER_NOT_INITIALISED");
  });

  it("flags a live-recorded submitter that differs from the declaration", async () => {
    mockDb([{ ...liveRow, evidence_recorded_by: "someone-else" }]);
    const report = await validateVaspOwnerAssignmentsAgainstRegister(dossierId, assignments().filter(r => r.area === "controlled_live_test").concat(assignments().filter(r => r.area !== "controlled_live_test")));
    expect(report.findings.some(f => f.code === "SUBMITTER_MISMATCH")).toBe(true);
  });

  it("rejects a manifest whose digest disagrees with the live register", async () => {
    mockDb([{ ...liveRow, status: "evidence_recorded", evidence_uri: "https://evidence.example/a.pdf", evidence_sha256: "a".repeat(64), evidence_recorded_by: "submitter-1" }]);
    const report = await validateVaspEvidenceManifestAgainstRegister(dossierId, [
      { area: "controlled_live_test", evidenceUri: "https://evidence.example/a.pdf", evidenceSha256: "b".repeat(64) },
    ]);
    expect(report.consistent).toBe(false);
    expect(report.findings.some(f => f.code === "EVIDENCE_DIGEST_MISMATCH")).toBe(true);
  });

  it("rejects declared attestation when the live item is not externally verified", async () => {
    mockDb([{ ...liveRow, status: "evidence_recorded", evidence_uri: "https://evidence.example/a.pdf", evidence_sha256: "a".repeat(64), evidence_recorded_by: "submitter-1" }]);
    const report = await validateVaspEvidenceManifestAgainstRegister(dossierId, [
      { area: "controlled_live_test", evidenceUri: "https://evidence.example/a.pdf", evidenceSha256: "a".repeat(64), attestationUri: "https://attest.example/x.pdf", attestationSha256: "c".repeat(64) },
    ]);
    expect(report.findings.some(f => f.code === "ATTESTATION_WITHOUT_VERIFICATION")).toBe(true);
  });

  it("rejects malformed digests and non-HTTPS URIs", async () => {
    mockDb();
    const report = await validateVaspEvidenceManifestAgainstRegister(dossierId, [
      { area: "controlled_live_test", evidenceUri: "http://insecure.example/a.pdf", evidenceSha256: "not-hex" },
    ]);
    const codes = report.findings.map(f => f.code);
    expect(codes).toContain("EVIDENCE_URI_NOT_HTTPS");
    expect(codes).toContain("EVIDENCE_DIGEST_MALFORMED");
  });

  it("fails closed when the dossier is not a VASP dossier", async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await expect(validateVaspOwnerAssignmentsAgainstRegister(dossierId, assignments())).rejects.toThrow("VASP dossier");
  });
});
