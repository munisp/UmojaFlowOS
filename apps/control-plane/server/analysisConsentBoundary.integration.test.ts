import { describe, expect, it } from "vitest";

import { listPostgresActiveVerificationConsents } from "./analysisSubmission";
import {
  countPostgresRows,
  createPostgresDocumentAnalysisJob,
  createPostgresVerificationConsent,
} from "./postgres";

const RUN_INTEGRATION = process.env.POSTGRES_INTEGRATION_TEST === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const officer = { openId: `regression-consent-officer-${Date.now()}`, role: "compliance_officer" as const };

const VALID_JOB = {
  caseKind: "kyc" as const,
  documentClass: "identity_document",
  sourceSha256: "b".repeat(64),
  sourceUri: "https://storage.example/kyc/consent-boundary",
  mimeType: "image/jpeg",
  selectedModelTag: "qwen3-vl:8b",
  selectedModelDigest: "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28",
  selectedModelRole: "visual_primary" as const,
};

async function consent(overrides: { scope?: "kyc" | "kyb"; expiresAt?: Date } = {}) {
  return createPostgresVerificationConsent(officer, {
    scope: overrides.scope ?? "kyc",
    subjectReference: `regression-consent-subject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    consentVersion: "2026.08",
    purpose: "Regression coverage for the consent boundary on analysis submission",
    grantedAt: new Date(Date.now() - 60_000),
    expiresAt: overrides.expiresAt,
  });
}

describeIntegration("analysis submission consent boundary", () => {
  it("rejects an expired consent and writes no analysis job", async () => {
    // Granted in the past and already expired.
    const expired = await consent({ expiresAt: new Date(Date.now() - 1_000) });
    const before = await countPostgresRows("document_analysis_jobs");

    await expect(
      createPostgresDocumentAnalysisJob(officer as never, { consentId: expired.id, ...VALID_JOB }),
    ).rejects.toThrow(/active consent/i);

    expect(await countPostgresRows("document_analysis_jobs")).toBe(before);

    // An expired consent is also absent from the console's submission surface.
    const active = await listPostgresActiveVerificationConsents();
    expect(active.some(row => row.id === expired.id)).toBe(false);
  });

  it("rejects a consent whose scope does not match the analysis scope", async () => {
    const kybConsent = await consent({ scope: "kyb" });
    const before = await countPostgresRows("document_analysis_jobs");

    await expect(
      // KYC analysis under a KYB consent is not a lawful basis.
      createPostgresDocumentAnalysisJob(officer as never, { consentId: kybConsent.id, ...VALID_JOB }),
    ).rejects.toThrow(/active consent/i);

    expect(await countPostgresRows("document_analysis_jobs")).toBe(before);
  });

  it("rejects an unknown consent identifier", async () => {
    const before = await countPostgresRows("document_analysis_jobs");
    await expect(
      createPostgresDocumentAnalysisJob(officer as never, {
        consentId: "00000000-0000-4000-8000-000000000000",
        ...VALID_JOB,
      }),
    ).rejects.toThrow(/active consent/i);
    expect(await countPostgresRows("document_analysis_jobs")).toBe(before);
  });

  it("accepts an active, scope-matched consent and lists it as submission-eligible", async () => {
    const active = await consent();
    const created = await createPostgresDocumentAnalysisJob(officer as never, { consentId: active.id, ...VALID_JOB });
    expect(created.id).toBeTruthy();

    const eligible = await listPostgresActiveVerificationConsents();
    const listed = eligible.find(row => row.id === active.id);
    expect(listed).toBeDefined();
    expect(listed?.scope).toBe("kyc");
  });
});
