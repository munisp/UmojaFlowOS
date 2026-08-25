import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const release = vi.fn();
const connect = vi.fn(async () => ({ query, release }));
const poolQuery = vi.fn();

vi.mock("./postgres", () => ({
  getPool: () => ({ connect, query: poolQuery }),
}));

import { initialiseReadinessAssurance, readinessAssuranceAreas, recordReadinessAssuranceEvidence, verifyReadinessAssuranceEvidence } from "./vaspReadinessAssurance";

const actor = { openId: "compliance-subject", role: "compliance_officer" as const };
const auditor = { openId: "independent-auditor", role: "auditor" as const };
const dossierId = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  query.mockResolvedValue({ rows: [] });
  poolQuery.mockResolvedValue({ rows: [] });
});

describe("VASP readiness assurance workflow", () => {
  it("defines the six residual evidence areas totalling 58 points", () => {
    expect(readinessAssuranceAreas).toEqual([
      "controlled_live_test", "governance_legal_ownership", "aml_cft_cpf_operations",
      "customer_asset_safeguarding", "cybersecurity_resilience", "consumer_incident_reporting",
    ]);
  });

  it("initialises every assurance area only for a VASP dossier", async () => {
    query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: dossierId, track: "vasp" }] });
    for (let index = 0; index < readinessAssuranceAreas.length; index += 1) query.mockResolvedValueOnce({ rows: [] });
    query.mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce({ rows: [] });
    await initialiseReadinessAssurance({ openId: "admin-subject", role: "admin" }, dossierId);
    const inserts = query.mock.calls.filter(([sql]) => String(sql).startsWith("INSERT INTO vasp_readiness_assurance_items"));
    expect(inserts).toHaveLength(6);
    expect(inserts.map(([, parameters]) => parameters[2]).sort((a, b) => a - b)).toEqual([6, 7, 8, 10, 13, 14]);
  });

  it("records HTTPS evidence for an open item without claiming verification", async () => {
    query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: dossierId, track: "vasp" }] })
      .mockResolvedValueOnce({ rows: [{ id: "item-1", status: "evidence_recorded" }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(recordReadinessAssuranceEvidence(actor, { dossierId, area: "aml_cft_cpf_operations", evidenceUri: "https://evidence.example/aml", evidenceSha256: "a".repeat(64) })).resolves.toEqual({ id: "item-1", status: "evidence_recorded" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status='evidence_recorded'"))).toBe(true);
  });

  it("refuses self-verification before any status transition", async () => {
    query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "item-1", evidenceRecordedBy: actor.openId }] });
    await expect(verifyReadinessAssuranceEvidence(actor, { dossierId, area: "aml_cft_cpf_operations", externalVerifier: "Independent AML reviewer", externalAttestationUri: "https://evidence.example/attestation", externalAttestationSha256: "b".repeat(64), rationale: "Independent reviewer checked the attributable evidence and retains a signed attestation." })).rejects.toThrow(/cannot independently verify/);
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status='externally_verified'"))).toBe(false);
  });

  it("records verification by an independent auditor without creating an approval claim", async () => {
    query.mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ id: "item-1", evidenceRecordedBy: actor.openId }] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });
    await expect(verifyReadinessAssuranceEvidence(auditor, { dossierId, area: "aml_cft_cpf_operations", externalVerifier: "Independent AML reviewer", externalAttestationUri: "https://evidence.example/attestation", externalAttestationSha256: "c".repeat(64), rationale: "Independent reviewer checked the attributable evidence and retains a signed attestation." })).resolves.toEqual({ id: "item-1", status: "externally_verified" });
    expect(query.mock.calls.some(([sql]) => String(sql).includes("status='externally_verified'"))).toBe(true);
  });
});
