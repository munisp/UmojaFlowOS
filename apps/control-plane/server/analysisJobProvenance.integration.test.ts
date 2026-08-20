import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { resolveSelectedModel, ModelProvenanceUnavailableError } from "./modelProvenance";
import {
  createPostgresCustomer,
  createPostgresDocumentAnalysisJob,
  createPostgresVerificationConsent,
  listPostgresDocumentAnalysisJobs,
} from "./postgres";

const RUN_INTEGRATION = process.env.POSTGRES_INTEGRATION_TEST === "1"
  && Boolean(process.env.DOCUMENT_INTELLIGENCE_SRC_PATH)
  && Boolean(process.env.OLLAMA_BASE_URL)
  && Boolean(process.env.OLLAMA_ALLOWED_MODEL_DIGESTS);
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const QWEN_DIGEST = "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28";
const DEEPSEEK_DIGEST = "6995872bfe4c521a67b32da386cd21d5c6e819b6e0d62f79f64ec83be99f5763";

const complianceActor = { openId: `provenance-compliance-${randomUUID()}`, role: "compliance_officer" as const };

/**
 * Exercises the full selector-to-PostgreSQL path that a compliance officer
 * triggers when creating an analysis job. Provenance must originate from the
 * Python selector reading the live private runtime, and an unresolvable or
 * drifted model must leave no analysis job behind at all.
 */
describeIntegration("analysis-job selector-derived provenance", () => {
  async function consentFor(caseKind: "kyc" | "kyb") {
    const customer = await createPostgresCustomer(complianceActor, {
      legalName: `Provenance regression ${randomUUID()}`,
      registrationIdentifier: `provenance-registration-${randomUUID()}`,
    });
    return createPostgresVerificationConsent(complianceActor, {
      scope: caseKind,
      subjectReference: customer.id,
      consentVersion: "regression-consent-v1",
      purpose: "identity_verification",
      grantedAt: new Date(),
    });
  }

  it("persists Qwen3-VL visual-primary provenance for image documents", async () => {
    const consent = await consentFor("kyc");
    const provenance = await resolveSelectedModel("image/jpeg");
    expect(provenance).toEqual({
      selectedModelTag: "qwen3-vl:8b",
      selectedModelDigest: QWEN_DIGEST,
      selectedModelRole: "visual_primary",
    });

    const job = await createPostgresDocumentAnalysisJob(complianceActor, {
      consentId: consent.id,
      caseKind: "kyc",
      documentClass: "identity_document",
      sourceSha256: "a".repeat(64),
      sourceUri: "https://storage.internal.example/provenance-regression-image",
      mimeType: "image/jpeg",
      ...provenance,
    });

    const jobs = await listPostgresDocumentAnalysisJobs();
    const persisted = jobs.find(row => row.id === job.id);
    expect(persisted?.selectedModelTag).toBe("qwen3-vl:8b");
    expect(persisted?.selectedModelDigest).toBe(QWEN_DIGEST);
    expect(persisted?.selectedModelRole).toBe("visual_primary");
  });

  it("persists DeepSeek text-fallback provenance for document inputs", async () => {
    const consent = await consentFor("kyb");
    const provenance = await resolveSelectedModel("application/pdf");
    expect(provenance).toEqual({
      selectedModelTag: "deepseek-r1:8b",
      selectedModelDigest: DEEPSEEK_DIGEST,
      selectedModelRole: "text_fallback",
    });

    const job = await createPostgresDocumentAnalysisJob(complianceActor, {
      consentId: consent.id,
      caseKind: "kyb",
      documentClass: "registration_certificate",
      sourceSha256: "b".repeat(64),
      sourceUri: "https://storage.internal.example/provenance-regression-pdf",
      mimeType: "application/pdf",
      ...provenance,
    });

    const jobs = await listPostgresDocumentAnalysisJobs();
    const persisted = jobs.find(row => row.id === job.id);
    expect(persisted?.selectedModelTag).toBe("deepseek-r1:8b");
    expect(persisted?.selectedModelRole).toBe("text_fallback");
  });

  it("writes no analysis job when the runtime is unreachable, for both modalities", async () => {
    // Scoped to this test's own consent rather than a global count: other test
    // files run in parallel against the same database and legitimately create
    // analysis jobs of their own, which would make a global count nondeterministic.
    const consent = await consentFor("kyc");
    const jobsForConsent = async () =>
      (await listPostgresDocumentAnalysisJobs()).filter(row => row.consentId === consent.id).length;
    const before = await jobsForConsent();
    const previousUrl = process.env.OLLAMA_BASE_URL;
    process.env.OLLAMA_BASE_URL = "http://127.0.0.1:1";
    try {
      for (const mimeType of ["image/jpeg", "application/pdf"]) {
        await expect(resolveSelectedModel(mimeType)).rejects.toBeInstanceOf(ModelProvenanceUnavailableError);
      }
    } finally {
      process.env.OLLAMA_BASE_URL = previousUrl;
    }
    expect(await jobsForConsent()).toBe(before);
  });

  it("writes no analysis job when the model digest has drifted, for both modalities", async () => {
    const consent = await consentFor("kyb");
    const jobsForConsent = async () =>
      (await listPostgresDocumentAnalysisJobs()).filter(row => row.consentId === consent.id).length;
    const before = await jobsForConsent();
    const previousDigests = process.env.OLLAMA_ALLOWED_MODEL_DIGESTS;
    process.env.OLLAMA_ALLOWED_MODEL_DIGESTS = "0".repeat(64);
    try {
      for (const mimeType of ["image/jpeg", "application/pdf"]) {
        await expect(resolveSelectedModel(mimeType)).rejects.toBeInstanceOf(ModelProvenanceUnavailableError);
      }
    } finally {
      process.env.OLLAMA_ALLOWED_MODEL_DIGESTS = previousDigests;
    }
    expect(await jobsForConsent()).toBe(before);
  });

  it("rejects a job whose provenance does not match the resolver contract", async () => {
    const consent = await consentFor("kyc");
    // DeepSeek can never be the visual primary; the repository must refuse it
    // even if a caller somehow assembled that combination.
    await expect(
      createPostgresDocumentAnalysisJob(complianceActor, {
        consentId: consent.id,
        caseKind: "kyc",
        documentClass: "identity_document",
        sourceSha256: "c".repeat(64),
        sourceUri: "https://storage.internal.example/provenance-regression-mismatch",
        mimeType: "image/jpeg",
        selectedModelTag: "deepseek-r1:8b",
        selectedModelDigest: DEEPSEEK_DIGEST,
        selectedModelRole: "visual_primary",
      }),
    ).rejects.toThrow();
  });
});
