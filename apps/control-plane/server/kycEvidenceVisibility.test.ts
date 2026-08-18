import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const routerSource = readFileSync(resolve(process.cwd(), "server/routers.ts"), "utf8");
const consoleSource = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");

function procedureGate(name: string): string | null {
  const match = routerSource.match(new RegExp(`\\b${name}:\\s*([a-zA-Z]+Procedure)`));
  return match ? match[1] : null;
}

/**
 * The evidence ledger is an audit surface: every role that may oversee a case
 * must be able to read it, but only a compliance officer may add evidence or
 * record a disposition. These assertions pin that asymmetry so a future change
 * cannot quietly widen the write surface.
 */
describe("KYC/KYB evidence ledger role boundaries", () => {
  it("exposes evidence, jobs, and decisions as auditor-readable reads", () => {
    expect(procedureGate("documentAnalysisEvidence")).toBe("auditorProcedure");
    expect(procedureGate("documentAnalysisJobs")).toBe("auditorProcedure");
    expect(procedureGate("reviewerDecisions")).toBe("auditorProcedure");
  });

  it("restricts evidence persistence and reviewer decisions to compliance officers", () => {
    expect(procedureGate("persistDocumentAnalysisEvidence")).toBe("complianceProcedure");
    expect(procedureGate("createReviewerDecision")).toBe("complianceProcedure");
    expect(procedureGate("createDocumentAnalysisJob")).toBe("complianceProcedure");
  });

  it("reads the ledger from the canonical PostgreSQL namespace only", () => {
    expect(consoleSource).toContain("trpc.postgres.documentAnalysisEvidence.useQuery()");
    expect(consoleSource).toContain("trpc.postgres.documentAnalysisJobs.useQuery()");
    expect(consoleSource).toContain("trpc.postgres.reviewerDecisions.useQuery()");
    // No transitional namespace may supply KYC/KYB evidence.
    expect(consoleSource).not.toMatch(/trpc\.umoja\.[a-zA-Z.]*[Ee]vidence/);
    expect(consoleSource).not.toMatch(/trpc\.umoja\.[a-zA-Z.]*reviewerDecision/i);
  });

  it("mounts the role-gated evidence workspace rather than ad-hoc evidence panels", () => {
    // The workspace owns the notice, ledger, reviewer form, and decision
    // history behind a single role gate, which is covered by DOM regressions in
    // client/src/components/KycEvidenceWorkspace.test.tsx.
    expect(consoleSource).toContain("<KycEvidenceWorkspace");
    expect(consoleSource).toContain("role={user?.role}");

    // No evidence surface may be rendered outside that gate.
    expect(consoleSource).not.toContain("<KycEvidenceLedger");
    expect(consoleSource).not.toContain("<ReviewerDecisionHistory");
    expect(consoleSource).not.toContain("<ReviewerDecisionForm");
  });
});
