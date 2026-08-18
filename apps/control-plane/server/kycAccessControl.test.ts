import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Access-control red team for the KYC/KYB analysis surface.
 *
 * Rather than asserting role behaviour indirectly, this reads the router source
 * and proves each KYC/KYB procedure is bound to a gate that excludes treasury
 * operators, auditors, and unauthenticated callers. A procedure that regresses to
 * a weaker gate fails here.
 */
const routerSource = readFileSync(join(process.cwd(), "server/routers.ts"), "utf8");

/** Procedures that create, alter, or decide identity-verification records. */
const DECISION_PROCEDURES = [
  "createVerificationConsent",
  "createDocumentAnalysisJob",
  "persistDocumentAnalysisEvidence",
  "createReviewerDecision",
  "updateKycDocumentReview",
];

/** Read-only ledgers an auditor is allowed to inspect. */
const AUDITOR_READABLE = [
  "documentAnalysisJobs",
  "documentAnalysisEvidence",
  "reviewerDecisions",
];

function gateFor(procedure: string): string | undefined {
  const match = routerSource.match(new RegExp(`\\b${procedure}:\\s*([A-Za-z]+Procedure)`));
  return match?.[1];
}

describe("KYC/KYB access-control red team", () => {
  it("binds every identity-verification mutation to the compliance-only gate", () => {
    for (const procedure of DECISION_PROCEDURES) {
      const gate = gateFor(procedure);
      expect(gate, `${procedure} must be present in the router`).toBeTruthy();
      // complianceProcedure admits compliance officers (and administrators where
      // the matrix permits); it never admits treasury operators or auditors.
      expect(gate, `${procedure} must not use a weaker gate`).toBe("complianceProcedure");
    }
  });

  it("never exposes an identity-verification mutation as public or merely authenticated", () => {
    for (const procedure of DECISION_PROCEDURES) {
      const gate = gateFor(procedure);
      expect(gate).not.toBe("publicProcedure");
      expect(gate).not.toBe("protectedProcedure");
      expect(gate).not.toBe("authenticatedProcedure");
      expect(gate).not.toBe("treasuryProcedure");
      expect(gate).not.toBe("auditorProcedure");
    }
  });

  it("keeps verification ledgers readable for audit without granting mutation rights", () => {
    for (const procedure of AUDITOR_READABLE) {
      const gate = gateFor(procedure);
      expect(gate, `${procedure} must be present in the router`).toBeTruthy();
      // A read gate is acceptable here; what matters is that it is a query.
      const declaration = routerSource.match(new RegExp(`\\b${procedure}:[^,]*`))?.[0] ?? "";
      expect(declaration).toContain(".query(");
      expect(declaration).not.toContain(".mutation(");
    }
  });

  it("exposes no procedure that returns an automated identity approval", () => {
    // An automated approval path would be a compliance failure, so no procedure
    // may be named for it.
    expect(routerSource).not.toMatch(/autoApprove(Kyc|Kyb|Verification)/i);
    expect(routerSource).not.toMatch(/approveCustomerAutomatically/i);
  });
});
