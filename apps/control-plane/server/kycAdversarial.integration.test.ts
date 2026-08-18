import { describe, expect, it } from "vitest";

import {
  createPostgresDocumentAnalysisJob,
  createPostgresReviewerDecision,
  createPostgresVerificationConsent,
  listPostgresActivityEventsForObjects,
  listPostgresDocumentAnalysisEvidence,
  persistPostgresDocumentAnalysisEvidence,
} from "./postgres";

const RUN_INTEGRATION = process.env.POSTGRES_INTEGRATION_TEST === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const officer = { openId: `regression-adv-officer-${Date.now()}`, role: "compliance_officer" as const };

/**
 * Digests of the exact bytes analysed. The workflow stores only the digest and a
 * storage URI, never the document bytes, so these values stand in for real
 * material without any document content entering the database.
 */
const DIGEST_A = "a".repeat(64);

async function activeConsent(scope: "kyc" | "kyb") {
  return createPostgresVerificationConsent(officer as never, {
    scope,
    subjectReference: `regression-adv-subject-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    consentVersion: "v1",
    purpose: "Adversarial-resilience regression for identity verification evidence handling.",
    grantedAt: new Date(),
    expiresAt: new Date(Date.now() + 86_400_000),
  });
}

async function analysisJob(scope: "kyc" | "kyb", documentClass: string) {
  const consent = await activeConsent(scope);
  return createPostgresDocumentAnalysisJob(officer as never, {
    consentId: consent.id,
    caseKind: scope,
    documentClass,
    sourceSha256: DIGEST_A,
    sourceUri: `s3://regression-adv/${Date.now()}`,
    mimeType: "image/png",
    selectedModelTag: "qwen3-vl:8b",
    selectedModelDigest: "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28",
    selectedModelRole: "visual_primary",
  } as never);
}

describeIntegration("KYC/KYB adversarial and privacy boundaries", () => {
  it("never lets analysis evidence carry an approval disposition", async () => {
    const job = await analysisJob("kyc", "national_identity_card");

    // The evidence layer is deliberately incapable of expressing an approval:
    // its only dispositions are review_required, insufficient_evidence, and
    // unavailable. An attempt to persist an approval must be rejected.
    await expect(
      persistPostgresDocumentAnalysisEvidence(officer as never, {
        analysisJobId: job.id,
        kind: "visual_consistency",
        disposition: "approved" as never,
        engineName: "ollama",
        engineVersion: "0.12.0",
        signals: [],
        limitations: ["Attempted automated approval."],
      }),
    ).rejects.toThrow();
  });

  it("records an adversarial or tampered document as review-required evidence, never as a rejection decision", async () => {
    const job = await analysisJob("kyc", "passport");

    // A strong tamper signal is still only evidence: the disposition remains
    // review_required so a human reviewer makes the actual determination.
    const evidence = await persistPostgresDocumentAnalysisEvidence(officer as never, {
      analysisJobId: job.id,
      kind: "presentation_attack_risk",
      disposition: "review_required",
      engineName: "ollama",
      engineVersion: "0.12.0",
      modelTag: "qwen3-vl:8b",
      modelDigest: "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28",
      signals: [{ name: "screen_replay_indicator", observed: true }],
      limitations: [
        "Evidence only. This signal does not constitute a presentation-attack determination and requires human review.",
      ],
    });
    expect(evidence.id).toBeTruthy();

    const rows = await listPostgresDocumentAnalysisEvidence();
    const persisted = rows.find(row => row.id === evidence.id);
    expect(persisted?.disposition).toBe("review_required");
  });

  it("persists an unavailable model state as evidence without producing any determination", async () => {
    const job = await analysisJob("kyb", "certificate_of_incorporation");

    const evidence = await persistPostgresDocumentAnalysisEvidence(officer as never, {
      analysisJobId: job.id,
      kind: "engine_unavailable",
      disposition: "unavailable",
      engineName: "ollama",
      engineVersion: "unavailable",
      signals: [],
      limitations: ["Private Ollama runtime was unreachable, so no analysis was performed."],
    });

    const rows = await listPostgresDocumentAnalysisEvidence();
    const persisted = rows.find(row => row.id === evidence.id);
    expect(persisted?.disposition).toBe("unavailable");
    // The unavailability itself is recorded as evidence, and the job is left in a
    // non-decided state rather than being silently closed.
    expect(persisted?.kind).toBe("engine_unavailable");
  });

  it("keeps the reviewer decision attributable and separate from evidence", async () => {
    const job = await analysisJob("kyc", "drivers_licence");
    await persistPostgresDocumentAnalysisEvidence(officer as never, {
      analysisJobId: job.id,
      kind: "ocr",
      disposition: "review_required",
      engineName: "paddleocr",
      engineVersion: "2.7.0",
      signals: [{ name: "text_regions", count: 12 }],
      limitations: ["Extraction only; no identity assertion."],
    });

    const decision = await createPostgresReviewerDecision(officer as never, {
      analysisJobId: job.id,
      disposition: "needs_information",
      rationale: "Extracted fields are legible but the address block is inconsistent with the application.",
    });

    const events = await listPostgresActivityEventsForObjects([decision.id]);
    const created = events.find(event => event.action === "verification_reviewer_decision.created");
    expect(created?.actorSubject).toBe(officer.openId);
    expect(created?.actorRole).toBe("compliance_officer");
  });

  it("stores no document bytes and no extracted personal-data payload in the evidence row", async () => {
    const job = await analysisJob("kyb", "board_resolution");
    const evidence = await persistPostgresDocumentAnalysisEvidence(officer as never, {
      analysisJobId: job.id,
      kind: "document_structure",
      disposition: "review_required",
      engineName: "docling",
      engineVersion: "2.0.0",
      // Signals are structural observations, never the document's personal data.
      signals: [{ name: "detected_sections", count: 4 }],
      limitations: ["Structure only; no personal data is retained in evidence."],
    });

    const rows = await listPostgresDocumentAnalysisEvidence();
    const persisted = rows.find(row => row.id === evidence.id);
    const serialised = JSON.stringify(persisted ?? {});
    // A privacy check: the evidence row must not carry base64 document payloads.
    expect(serialised).not.toMatch(/data:image\//);
    expect(serialised).not.toMatch(/[A-Za-z0-9+/]{512,}={0,2}/);
  });

  it("refuses an analysis job whose source digest is not a full SHA-256 value", async () => {
    const consent = await activeConsent("kyc");
    await expect(
      createPostgresDocumentAnalysisJob(officer as never, {
        consentId: consent.id,
        caseKind: "kyc",
        documentClass: "national_identity_card",
        // A truncated digest cannot bind the evidence to specific bytes.
        sourceSha256: "deadbeef",
        sourceUri: "s3://regression-adv/truncated",
        mimeType: "image/png",
        selectedModelTag: "qwen3-vl:8b",
        selectedModelDigest: "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28",
        selectedModelRole: "visual_primary",
      } as never),
    ).rejects.toThrow();
  });
});
