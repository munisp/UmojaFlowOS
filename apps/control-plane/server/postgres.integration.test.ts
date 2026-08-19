import { afterAll, describe, expect, it } from "vitest";
import { closePostgresPool, createPostgresDocumentAnalysisJob, createPostgresReviewerDecision, createPostgresVerificationConsent, getPostgresCutoverReadiness, getPostgresPrivilegeBoundary, getPostgresReadiness, listPostgresActivityEventsForObjects, listPostgresCounterparties, listPostgresCounterpartyAuthorizations, listPostgresDocumentAnalysisJobs, listPostgresKycDocuments, listPostgresNotificationDeliveries, listPostgresRegulatoryDeadlines, listPostgresSarStrFilings, persistPostgresDocumentAnalysisEvidence } from "./postgres";

const QWEN_VISUAL_DIGEST = "901cae73216286ea8c5aba8b46d307ff7188f737285ec500c795a12f05225d28";
const DEEPSEEK_TEXT_DIGEST = "6995872bfe4c521a67b32da386cd21d5c6e819b6e0d62f79f64ec83be99f5763";

const runIntegration = process.env.POSTGRES_INTEGRATION_TEST === "1";

describe.skipIf(!runIntegration)("local PostgreSQL canonical schema", () => {
  afterAll(async () => {
    await closePostgresPool();
  });

  it("connects through the local peer-authenticated role and exposes the canonical table set", async () => {
    const readiness = await getPostgresReadiness();
    expect(readiness.connected).toBe(true);
    expect(readiness.database).toBe("umojaflowos_dev");
    // 36 canonical tables after migration 0012 added append-only service
    // health samples for operator-visible history.
    expect(readiness.tableCount).toBe(36);
    expect(readiness.version).toContain("PostgreSQL");
  });

  it("reports local canonical-schema cutover readiness without representing production deployment as complete", async () => {
    const readiness = await getPostgresCutoverReadiness();
    expect(readiness.ready).toBe(true);
    expect(readiness.missingTables).toEqual([]);
    expect(readiness.activationBoundary).toContain("production cutover still requires");
  });

  it("reads the canonical counterparty and licence-authorisation ledgers without creating operational records", async () => {
    const [counterparties, authorizations] = await Promise.all([
      listPostgresCounterparties(),
      listPostgresCounterpartyAuthorizations(),
    ]);

    expect(Array.isArray(counterparties)).toBe(true);
    expect(Array.isArray(authorizations)).toBe(true);
    expect(counterparties.every(record => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id))).toBe(true);
    expect(authorizations.every(record => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(record.id))).toBe(true);
    expect(authorizations.every(record => counterparties.some(counterparty => counterparty.id === record.counterpartyId))).toBe(true);
  });

  it("reads provider-independent compliance and regulatory evidence ledgers without creating source records", async () => {
    const [kycDocuments, filings, deadlines, deliveries] = await Promise.all([
      listPostgresKycDocuments(),
      listPostgresSarStrFilings(),
      listPostgresRegulatoryDeadlines(),
      listPostgresNotificationDeliveries(),
    ]);

    expect(Array.isArray(kycDocuments)).toBe(true);
    expect(Array.isArray(filings)).toBe(true);
    expect(Array.isArray(deadlines)).toBe(true);
    expect(Array.isArray(deliveries)).toBe(true);
    expect(filings.every(filing => filing.status !== "submitted" || filing.submissionReference)).toBe(true);
  });

  it("persists the selected review-only model tag, digest, and role on each analysis job", async () => {
    const officer = { openId: `provenance-officer-${Date.now()}`, role: "compliance_officer" as const };
    const consent = await createPostgresVerificationConsent(officer, {
      scope: "kyc",
      subjectReference: `provenance-subject-${Date.now()}`,
      consentVersion: "2026-08-kyc-analysis-v1",
      purpose: "Human-reviewed KYC document evidence generation for NGN, KES, and ZAR corridor onboarding.",
      grantedAt: new Date(),
    });

    const job = await createPostgresDocumentAnalysisJob(officer, {
      consentId: consent.id,
      caseKind: "kyc",
      documentClass: "identity_document",
      sourceSha256: "b".repeat(64),
      sourceUri: `s3://umojaflowos-kyc-evidence/provenance/${consent.id}`,
      mimeType: "image/png",
      selectedModelTag: "qwen3-vl:8b",
      selectedModelDigest: QWEN_VISUAL_DIGEST,
      selectedModelRole: "visual_primary",
    });

    const persisted = (await listPostgresDocumentAnalysisJobs()).find(record => record.id === job.id);
    expect(persisted?.selectedModelTag).toBe("qwen3-vl:8b");
    expect(persisted?.selectedModelDigest).toBe(QWEN_VISUAL_DIGEST);
    expect(persisted?.selectedModelRole).toBe("visual_primary");
    expect(persisted?.state).toBe("queued");
    expect(persisted?.completedAt).toBeNull();
  });

  it("fails closed and creates no analysis job when the selected model provenance is incomplete", async () => {
    const officer = { openId: `incomplete-officer-${Date.now()}`, role: "compliance_officer" as const };
    const consent = await createPostgresVerificationConsent(officer, {
      scope: "kyc",
      subjectReference: `incomplete-subject-${Date.now()}`,
      consentVersion: "2026-08-kyc-analysis-v1",
      purpose: "Human-reviewed KYC document evidence generation for NGN, KES, and ZAR corridor onboarding.",
      grantedAt: new Date(),
    });
    // Scope the assertion to this consent. A global count races with the other
    // integration files vitest runs in parallel against the same database.
    const countOwnJobs = async () => (await listPostgresDocumentAnalysisJobs()).filter(job => job.consentId === consent.id).length;
    const before = await countOwnJobs();

    await expect(
      createPostgresDocumentAnalysisJob(officer, {
        consentId: consent.id,
        caseKind: "kyc",
        documentClass: "identity_document",
        sourceSha256: "c".repeat(64),
        sourceUri: `s3://umojaflowos-kyc-evidence/incomplete/${consent.id}`,
        mimeType: "image/png",
        selectedModelTag: "qwen3-vl:8b",
      }),
    ).rejects.toThrow(/selected model tag, digest, and role must be supplied together/);

    expect(await countOwnJobs()).toBe(before);
    expect(before).toBe(0);
  });

  it("persists the DeepSeek text-fallback provenance distinctly from the visual-primary path", async () => {
    const officer = { openId: `fallback-officer-${Date.now()}`, role: "compliance_officer" as const };
    const consent = await createPostgresVerificationConsent(officer, {
      scope: "kyb",
      subjectReference: `fallback-subject-${Date.now()}`,
      consentVersion: "2026-08-kyb-analysis-v1",
      purpose: "Human-reviewed KYB registry-text evidence generation for NGN, KES, and ZAR corridor counterparties.",
      grantedAt: new Date(),
    });

    const job = await createPostgresDocumentAnalysisJob(officer, {
      consentId: consent.id,
      caseKind: "kyb",
      documentClass: "company_registry_extract",
      sourceSha256: "f".repeat(64),
      sourceUri: `s3://umojaflowos-kyb-evidence/fallback/${consent.id}`,
      mimeType: "application/pdf",
      selectedModelTag: "deepseek-r1:8b",
      selectedModelDigest: DEEPSEEK_TEXT_DIGEST,
      selectedModelRole: "text_fallback",
    });

    const persisted = (await listPostgresDocumentAnalysisJobs()).find(record => record.id === job.id);
    expect(persisted?.selectedModelTag).toBe("deepseek-r1:8b");
    expect(persisted?.selectedModelDigest).toBe(DEEPSEEK_TEXT_DIGEST);
    expect(persisted?.selectedModelRole).toBe("text_fallback");
    expect(persisted?.selectedModelDigest).not.toBe(QWEN_VISUAL_DIGEST);
    expect(persisted?.completedAt).toBeNull();
  });

  it("writes an immutable activity event for every KYC/KYB workflow mutation", async () => {
    const officer = { openId: `audit-officer-${Date.now()}`, role: "compliance_officer" as const };
    const consent = await createPostgresVerificationConsent(officer, {
      scope: "kyc",
      subjectReference: `audit-subject-${Date.now()}`,
      consentVersion: "2026-08-kyc-analysis-v1",
      purpose: "Human-reviewed KYC document evidence generation for NGN, KES, and ZAR corridor onboarding.",
      grantedAt: new Date(),
    });
    const job = await createPostgresDocumentAnalysisJob(officer, {
      consentId: consent.id,
      caseKind: "kyc",
      documentClass: "identity_document",
      sourceSha256: "9".repeat(64),
      sourceUri: `s3://umojaflowos-kyc-evidence/audit/${consent.id}`,
      mimeType: "image/png",
      selectedModelTag: "qwen3-vl:8b",
      selectedModelDigest: QWEN_VISUAL_DIGEST,
      selectedModelRole: "visual_primary",
    });
    const evidence = await persistPostgresDocumentAnalysisEvidence(officer, {
      analysisJobId: job.id,
      kind: "engine_unavailable",
      disposition: "unavailable",
      engineName: "ollama-qwen3-vl",
      engineVersion: "activation-gated",
      signals: [],
      limitations: ["No authorised document imagery was supplied, so no visual analysis was attempted."],
    });
    const decision = await createPostgresReviewerDecision(officer, {
      analysisJobId: job.id,
      disposition: "needs_information",
      rationale: "Evidence generation was unavailable, so the case requires additional authorised documentation before any disposition.",
    });

    const events = await listPostgresActivityEventsForObjects([consent.id, job.id, evidence.id, decision.id]);
    const actions = events.map(event => event.action);
    expect(actions).toContain("verification_consent.captured");
    expect(actions).toContain("document_analysis_job.created");
    expect(actions).toContain("document_analysis_evidence.persisted");
    expect(actions).toContain("verification_reviewer_decision.created");
    expect(events.every(event => event.actorSubject === officer.openId && event.actorRole === "compliance_officer")).toBe(true);

    const jobEvent = events.find(event => event.action === "document_analysis_job.created");
    expect((jobEvent?.metadata as { selectedModelDigest?: string })?.selectedModelDigest).toBe(QWEN_VISUAL_DIGEST);

    const boundary = await getPostgresPrivilegeBoundary();
    const auditTable = boundary.tables.find(entry => entry.table === "activity_events");
    expect(auditTable?.update).toBe(false);
    expect(auditTable?.delete).toBe(false);
  });

  it("keeps audit and evidence trails append-only for the application role", async () => {
    const boundary = await getPostgresPrivilegeBoundary();

    expect(boundary.appendOnlyViolations).toEqual([]);
    expect(boundary.ownsSchemaObjects).toBe(false);
    expect(boundary.canCreateInSchema).toBe(false);
    for (const table of ["activity_events", "document_analysis_evidence", "verification_reviewer_decisions", "policy_decisions"]) {
      const record = boundary.tables.find(entry => entry.table === table);
      expect(record?.insert).toBe(true);
      expect(record?.update).toBe(false);
      expect(record?.delete).toBe(false);
    }
  });
});
