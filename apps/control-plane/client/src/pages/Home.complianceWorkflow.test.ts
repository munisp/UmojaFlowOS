import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { visibleConsoleModuleActions } from "@/lib/consoleActionVisibility";

const HOME = readFileSync(resolve(process.cwd(), "client/src/pages/Home.tsx"), "utf8");

describe("compliance console workflow completeness", () => {
  it("exposes every stage of the KYC/KYB sequence", () => {
    // 1. consent capture, 2. S3-backed ingestion, 3. analysis submission,
    // 4. evidence and reviewer views, 5. case disposition.
    expect(HOME).toContain("VerificationConsentForm");
    expect(HOME).toContain("KycDocumentUploadForm");
    expect(HOME).toContain("AnalysisJobSubmissionForm");
    expect(HOME).toContain("KycEvidenceWorkspace");
    expect(HOME).toContain("ComplianceCaseDispositionControls");
  });

  it("binds each stage to a canonical PostgreSQL procedure", () => {
    for (const procedure of [
      "trpc.postgres.createVerificationConsent",
      "trpc.postgres.createKycDocumentUploadIntent",
      "trpc.postgres.finalizeKycDocumentUpload",
      "trpc.postgres.createDocumentAnalysisJob",
      "trpc.postgres.createReviewerDecision",
      "trpc.postgres.disposeComplianceCase",
    ]) {
      expect(HOME).toContain(procedure);
    }
  });

  it("feeds analysis submission from active consents and verified documents only", () => {
    expect(HOME).toContain("trpc.postgres.activeVerificationConsents");
    expect(HOME).toContain("trpc.postgres.analysisReadyDocuments");
  });

  it("offers consent and analysis to compliance officers only", () => {
    const officer = visibleConsoleModuleActions("compliance_officer", "compliance");
    expect(officer).toContain("Consent");
    expect(officer).toContain("Analyse");

    // An administrator's delegated compliance access stops short of the data
    // subject's lawful basis and of submitting their document for analysis.
    const administrator = visibleConsoleModuleActions("admin", "compliance");
    expect(administrator).not.toContain("Consent");
    expect(administrator).not.toContain("Analyse");

    for (const role of ["auditor", "treasury_operator"] as const) {
      expect(visibleConsoleModuleActions(role, "compliance")).toEqual([]);
    }
  });

  it("never lets the console assert model provenance", () => {
    // Provenance is resolved server-side from the live runtime inventory.
    expect(HOME).not.toContain("selectedModelTag");
    expect(HOME).not.toContain("selectedModelDigest");
    expect(HOME).not.toContain("selectedModelRole");
  });
});
