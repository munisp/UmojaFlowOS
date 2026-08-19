import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { probeProviderEndpoint } from "./providerHealthCheck";
import { collectAllServiceStatuses } from "./serviceHealth";
import { listServiceHealthHistory, recordServiceHealthSamples, summariseServiceAvailability } from "./serviceHealthHistory";
import {
  activatePostgresIntegrationConnection,
  configurePostgresIntegrationCredential,
  listPostgresIntegrationCredentialStatus,
  listPostgresCredentialAuditTrail,
  suspendPostgresIntegrationConnection,
} from "./postgres";
import { evaluatePostgresLiquidityThresholds, evaluatePostgresPaymentFailures, evaluatePostgresComplianceFlags, computePostgresFxSpread } from "./operationalAlerts";
import { raisePostgresComplianceAlert, acknowledgePostgresComplianceAlert, escalatePostgresComplianceAlert, dismissPostgresComplianceAlert, listPostgresComplianceAlerts } from "./complianceAlerts";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, auditorProcedure, complianceOnlyProcedure, complianceProcedure, publicProcedure, router, treasuryProcedure } from "./_core/trpc";
import { listPostgresActiveVerificationConsents, listPostgresAnalysisReadyDocuments } from "./analysisSubmission";
import { registerPostgresLegalEntity } from "./legalEntityRegistry";
import { disposeComplianceCase } from "./complianceCaseWorkflow";
import { resolveSelectedModel } from "./modelProvenance";
import { transitionPostgresPaymentLeg, createPostgresPaymentLeg, createPostgresPaymentOrder, expirePostgresRateLocks, listPostgresPaymentLegs, listPostgresPaymentOrders, transitionPostgresPaymentOrder } from "./paymentWorkflow";
import { listPostgresTreasuryRecommendations, listPostgresTreasuryBufferPolicies, listPostgresLegalEntities, transitionPostgresCounterpartyAuthorization, evaluatePostgresRegulatoryDeadlines, cancelPostgresRateLock, createPostgresAlertPolicy, createPostgresBeneficiary, createPostgresComplianceCase, createPostgresCorridorPolicy, createPostgresCounterparty, createPostgresCounterpartyAuthorization, createPostgresCounterpartyRiskAssessment, createPostgresCustomer, createPostgresDocumentAnalysisJob, createPostgresIntegrationConnection, createPostgresKycDocumentUploadIntent, createPostgresRateLock, createPostgresRegulatoryDeadline, createPostgresRegulatoryReport, createPostgresReviewerDecision, createPostgresSarStrFiling, createPostgresTreasuryRecommendation, createPostgresVerificationConsent, decidePostgresTreasuryRecommendation, escalatePostgresCounterpartyRiskAssessment, finalizePostgresKycDocumentUpload, getPostgresCutoverReadiness, getPostgresReadiness, listPostgresAlertPolicies, listPostgresBeneficiaries, listPostgresComplianceCases, listPostgresCorridorPolicies, listPostgresCounterparties, listPostgresCounterpartyAuthorizations, listPostgresCounterpartyRiskAssessments, listPostgresCustomers, listPostgresDocumentAnalysisEvidence, listPostgresDocumentAnalysisJobs, listPostgresIntegrationConnections, listPostgresKycDocuments, listPostgresLiquidityPositions, listPostgresMarketObservations, listPostgresNotificationDeliveries, listPostgresRateLocks, listPostgresRegulatoryDeadlines, listPostgresRegulatoryReports, listPostgresReviewerDecisions, listPostgresSarStrFilings, persistPostgresDocumentAnalysisEvidence, recordPostgresLiquidityPosition, recordPostgresMarketObservation, transitionPostgresRegulatoryReport, transitionPostgresSarStrFiling, updatePostgresKycDocumentReview } from "./postgres";
import { umojaFlowRouter } from "./routers/umojaflowos";
import { parseGoPaymentOrderValidatedEvent, parsePythonBronzeBatchManifest, parseRustNonExecutablePolicyDecisionEvent } from "./contracts/events";
import {
  describeServiceConfiguration,
  evaluateMonitoringViaService,
  assessCounterpartyRiskViaService,
  monitoringInputSchema,
  counterpartyRiskInputSchema,
  validateLedgerPostingsViaService,
  reconcileLedgerProjectionViaService,
  ledgerPostingSchema,
  ledgerReconciliationInputSchema,
} from "./serviceBridge";
import {
  parseGoAuditTrailEnvelope,
  parseRustMonitoringResult,
  parseRustCounterpartyRisk,
  parsePythonAssembledReport,
  parsePythonStablecoinExposure,
  parseRustLedgerValidation,
  parseRustLedgerReconciliation,
} from "./contracts/services";
import { z } from "zod";

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    logout: publicProcedure.mutation(({ ctx }) => {
      const cookieOptions = getSessionCookieOptions(ctx.req);
      ctx.res.clearCookie(COOKIE_NAME, { ...cookieOptions, maxAge: -1 });
      return {
        success: true,
      } as const;
    }),
  }),
  postgres: router({
    readiness: auditorProcedure.query(() => getPostgresReadiness()),
    cutoverReadiness: auditorProcedure.query(() => getPostgresCutoverReadiness()),
    counterparties: auditorProcedure.query(() => listPostgresCounterparties()),
    customers: auditorProcedure.query(() => listPostgresCustomers()),
    beneficiaries: auditorProcedure.input(z.object({ customerId: z.string().uuid().optional() }).optional()).query(({ input }) => listPostgresBeneficiaries(input?.customerId)),
    createCustomer: complianceProcedure.input(z.object({ legalName: z.string().trim().min(2).max(255), registrationIdentifier: z.string().trim().min(2).max(255) })).mutation(({ ctx, input }) => createPostgresCustomer({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createBeneficiary: complianceProcedure.input(z.object({ customerId: z.string().uuid(), legalName: z.string().trim().min(2).max(255), countryCode: z.string().trim().length(2).toUpperCase(), bankOrWalletReference: z.string().trim().min(4).max(512) })).mutation(({ ctx, input }) => createPostgresBeneficiary({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    counterpartyAuthorizations: auditorProcedure.query(() => listPostgresCounterpartyAuthorizations()),
    transitionCounterpartyAuthorization: adminProcedure.input(z.object({ authorizationId: z.string().uuid(), status: z.enum(["pending_review", "verified", "expired", "suspended", "rejected"]) })).mutation(({ ctx, input }) => transitionPostgresCounterpartyAuthorization({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    legalEntities: auditorProcedure.query(() => listPostgresLegalEntities()),
    integrationConnections: auditorProcedure.query(() => listPostgresIntegrationConnections()),
    corridorPolicies: auditorProcedure.query(() => listPostgresCorridorPolicies()),
    rateLocks: auditorProcedure.query(() => listPostgresRateLocks()),
    evaluateLiquidityThresholds: treasuryProcedure.mutation(({ ctx }) => evaluatePostgresLiquidityThresholds({ subject: ctx.user.openId, role: ctx.user.role })),
    evaluatePaymentFailures: treasuryProcedure.mutation(({ ctx }) => evaluatePostgresPaymentFailures({ subject: ctx.user.openId, role: ctx.user.role })),
    evaluateComplianceFlags: complianceProcedure.mutation(({ ctx }) => evaluatePostgresComplianceFlags({ subject: ctx.user.openId, role: ctx.user.role })),
    complianceAlerts: auditorProcedure.input(z.object({ state: z.enum(["open","acknowledged","escalated","dismissed"]).optional(), limit: z.number().int().min(1).max(500).optional() }).optional()).query(({ input }) => listPostgresComplianceAlerts(input ?? {})),
    raiseComplianceAlert: complianceProcedure.input(z.object({ alertPolicyId: z.string().uuid(), severity: z.enum(["low","medium","high","critical"]), sourceReference: z.string().trim().min(8).max(512), evidence: z.unknown(), detectedAt: z.coerce.date(), paymentOrderId: z.string().uuid().nullish(), customerId: z.string().uuid().nullish(), counterpartyId: z.string().uuid().nullish() })).mutation(({ ctx, input }) => raisePostgresComplianceAlert({ subject: ctx.user.openId, role: ctx.user.role }, input)),
    acknowledgeComplianceAlert: complianceProcedure.input(z.object({ alertId: z.string().uuid(), note: z.string().trim().min(8).max(2000) })).mutation(({ ctx, input }) => acknowledgePostgresComplianceAlert({ subject: ctx.user.openId, role: ctx.user.role }, input)),
    escalateComplianceAlert: complianceProcedure.input(z.object({ alertId: z.string().uuid(), caseId: z.string().uuid() })).mutation(({ ctx, input }) => escalatePostgresComplianceAlert({ subject: ctx.user.openId, role: ctx.user.role }, input)),
    dismissComplianceAlert: complianceProcedure.input(z.object({ alertId: z.string().uuid(), reason: z.string().trim().min(8).max(2000) })).mutation(({ ctx, input }) => dismissPostgresComplianceAlert({ subject: ctx.user.openId, role: ctx.user.role }, input)),
    fxSpread: auditorProcedure.input(z.object({ baseAsset: z.enum(["NGN","KES","ZAR","USD","USDC","USDT"]), quoteAsset: z.enum(["NGN","KES","ZAR","USD","USDC","USDT"]), windowMinutes: z.number().int().min(1).max(1440).optional() })).query(({ input }) => computePostgresFxSpread(input.baseAsset, input.quoteAsset, { windowMinutes: input.windowMinutes })),
    alertPolicies: auditorProcedure.query(() => listPostgresAlertPolicies()),
    createIntegrationConnection: adminProcedure.input(z.object({ counterpartyId: z.string().uuid(), category: z.enum(["payment_rail", "fx_rate", "stablecoin_market_data", "kyc_kyb", "sanctions", "chain_analytics", "notification", "regulatory_submission"]), environment: z.enum(["sandbox", "production"]), documentationUrl: z.string().url() })).mutation(({ ctx, input }) => createPostgresIntegrationConnection({ openId: ctx.user.openId, role: ctx.user.role }, input)),

    /**
     * Provider credential configuration and activation.
     *
     * Administrator-only, because supplying the credential that makes a
     * corridor live is the single most consequential configuration action in
     * the platform. Note that the read is also administrator-only rather than
     * auditor-readable: the secret *reference* names a deployment secret, and
     * that name is itself operational information.
     */
    integrationCredentialStatus: adminProcedure.query(() => listPostgresIntegrationCredentialStatus()),

    /**
     * The credential change history for one integration.
     *
     * Administrator-only for the same reason as the status read: a secret
     * reference name is operational information even though it is not a secret.
     */
    integrationCredentialAuditTrail: adminProcedure
      .input(z.object({ integrationConnectionId: z.string().uuid(), limit: z.number().int().min(1).max(200).optional() }))
      .query(({ input }) => listPostgresCredentialAuditTrail(input)),

    /**
     * Live health and metrics for the Go, Rust, and Python services.
     *
     * Auditor-readable because operational visibility is a read, and withholding
     * it from the roles who respond to incidents would be counterproductive. The
     * collection itself performs real HTTP reads against configured endpoints
     * only; an unconfigured service is reported as such rather than as failing.
     */
    serviceStatus: auditorProcedure.query(() => collectAllServiceStatuses()),

    /**
     * Recorded history for trend charts. Auditor-readable for the same reason
     * the live read is: responding to an incident requires seeing what led to
     * it.
     */
    serviceHealthHistory: auditorProcedure
      .input(z.object({ sinceMinutes: z.number().int().min(1).max(43200).optional(), service: z.string().optional() }).optional())
      .query(({ input }) => listServiceHealthHistory(input ?? {})),

    serviceAvailabilitySummary: auditorProcedure
      .input(z.object({ sinceMinutes: z.number().int().min(1).max(43200).optional() }).optional())
      .query(({ input }) => summariseServiceAvailability(input?.sinceMinutes ?? 60)),

    /**
     * Collects one round and records it.
     *
     * A mutation rather than a query because it writes. Restricted to
     * administrators when triggered by hand; the scheduled collector calls the
     * same underlying functions through the cron endpoint, so both paths record
     * identically shaped samples.
     */
    captureServiceHealthSample: adminProcedure.mutation(async () => {
      const collected = await collectAllServiceStatuses();
      const written = await recordServiceHealthSamples(collected.services);
      return { written, observedAt: collected.observedAt };
    }),

    configureIntegrationCredential: adminProcedure
      .input(z.object({
        integrationConnectionId: z.string().uuid(),
        // Constrained to a deployment-secret name; the repository additionally
        // refuses anything credential-shaped.
        secretReference: z.string().trim().min(3).max(64),
        endpointUrl: z.string().url(),
      }))
      .mutation(({ ctx, input }) => configurePostgresIntegrationCredential({ openId: ctx.user.openId, role: ctx.user.role }, input)),

    /**
     * Attempts activation. The probe runs first and its outcome is passed to
     * the repository, which decides. A failed or unreachable probe records a
     * failed activation rather than throwing, so the operator sees why.
     */
    activateIntegrationConnection: adminProcedure
      .input(z.object({ integrationConnectionId: z.string().uuid() }))
      .mutation(async ({ ctx, input }) => {
        const connections = await listPostgresIntegrationCredentialStatus();
        const connection = connections.find((row: { id: string }) => row.id === input.integrationConnectionId);
        if (!connection) throw new TRPCError({ code: "NOT_FOUND", message: "integration connection does not exist" });
        if (!connection.secretReference) {
          throw new TRPCError({ code: "PRECONDITION_FAILED", message: "configure a credential reference before attempting activation" });
        }
        const outcome = await probeProviderEndpoint({ endpoint: connection.endpoint, secretReference: connection.secretReference });
        return activatePostgresIntegrationConnection({ openId: ctx.user.openId, role: ctx.user.role }, { integrationConnectionId: input.integrationConnectionId, outcome });
      }),

    suspendIntegrationConnection: adminProcedure
      .input(z.object({ integrationConnectionId: z.string().uuid(), reason: z.string().trim().min(10).max(500) }))
      .mutation(({ ctx, input }) => suspendPostgresIntegrationConnection({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createCorridorPolicy: complianceProcedure.input(z.object({ corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]), regulator: z.enum(["CBN", "CBK", "SARB"]), policyVersion: z.string().trim().min(1).max(64), effectiveFrom: z.coerce.date(), effectiveTo: z.coerce.date().optional(), requiresTravelRule: z.boolean(), requiresAuthorisedFxIntermediary: z.boolean(), policyDocumentUri: z.string().url() })).mutation(({ ctx, input }) => createPostgresCorridorPolicy({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    paymentOrders: auditorProcedure.query(() => listPostgresPaymentOrders()),
    paymentLegs: auditorProcedure.input(z.object({ paymentOrderId: z.string().uuid().optional() }).optional()).query(({ input }) => listPostgresPaymentLegs(input?.paymentOrderId)),
    expireRateLocks: treasuryProcedure.mutation(({ ctx }) => expirePostgresRateLocks({ openId: ctx.user.openId, role: ctx.user.role })),
    createPaymentOrder: treasuryProcedure
      .input(z.object({ idempotencyKey: z.string().min(8).max(120), customerId: z.string().uuid(), beneficiaryId: z.string().uuid(), rateLockId: z.string().uuid(), sourceAmount: z.string().regex(/^\d+(\.\d{1,8})?$/) }))
      .mutation(({ ctx, input }) => createPostgresPaymentOrder({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createPaymentLeg: treasuryProcedure
      .input(z.object({ paymentOrderId: z.string().uuid(), sequenceNumber: z.number().int().min(1).max(20), legKind: z.string().min(3).max(60), counterpartyId: z.string().uuid() }))
      .mutation(({ ctx, input }) => createPostgresPaymentLeg({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    transitionPaymentOrder: treasuryProcedure
      .input(z.object({ paymentOrderId: z.string().uuid(), status: z.enum(["pending_policy_decision", "blocked", "manual_review", "approved", "cancelled"]), reason: z.string().min(10).max(2000) }))
      .mutation(({ ctx, input }) => transitionPostgresPaymentOrder({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    transitionPaymentLeg: treasuryProcedure
      .input(z.object({ paymentLegId: z.string().uuid(), status: z.enum(["pending_policy_decision", "blocked", "manual_review", "approved", "cancelled"]), reason: z.string().min(10).max(2000) }))
      .mutation(({ ctx, input }) => transitionPostgresPaymentLeg({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createRateLock: treasuryProcedure.input(z.object({ marketObservationId: z.string().uuid(), corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]), expiresAt: z.coerce.date() })).mutation(({ ctx, input }) => createPostgresRateLock({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    cancelRateLock: treasuryProcedure.input(z.object({ rateLockId: z.string().uuid() })).mutation(({ ctx, input }) => cancelPostgresRateLock({ openId: ctx.user.openId, role: ctx.user.role }, input.rateLockId)),
    createRegulatoryDeadline: complianceProcedure.input(z.object({ regulator: z.enum(["CBN", "CBK", "SARB"]), corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]), title: z.string().trim().min(4).max(255), dueAt: z.coerce.date(), sourceReference: z.string().trim().min(4).max(512) })).mutation(({ ctx, input }) => createPostgresRegulatoryDeadline({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    evaluateRegulatoryDeadlines: adminProcedure.mutation(({ ctx }) => evaluatePostgresRegulatoryDeadlines({ openId: ctx.user.openId, role: ctx.user.role })),
    createAlertPolicy: adminProcedure.input(z.object({ alertType: z.enum(["liquidity_threshold", "payment_failure", "compliance_flag", "regulatory_deadline"]), corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]).optional(), threshold: z.record(z.string(), z.unknown()) })).mutation(({ ctx, input }) => createPostgresAlertPolicy({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    liquidityPositions: auditorProcedure.query(() => listPostgresLiquidityPositions()),
    marketObservations: auditorProcedure.query(() => listPostgresMarketObservations()),
    counterpartyRiskAssessments: auditorProcedure.query(() => listPostgresCounterpartyRiskAssessments()),
    kycDocuments: auditorProcedure.query(() => listPostgresKycDocuments()),
    createKycDocumentUploadIntent: complianceProcedure.input(z.object({ customerId: z.string().uuid(), documentType: z.enum(["registration_certificate", "identity_document", "proof_of_address", "beneficial_ownership", "source_of_funds", "other"]), originalFilename: z.string().trim().min(1).max(255), mimeType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff"]), sizeBytes: z.number().int().positive().max(26_214_400), contentSha256: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(({ ctx, input }) => createPostgresKycDocumentUploadIntent({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    finalizeKycDocumentUpload: complianceProcedure.input(z.object({ uploadIntentId: z.string().uuid() })).mutation(({ ctx, input }) => finalizePostgresKycDocumentUpload({ openId: ctx.user.openId, role: ctx.user.role }, input.uploadIntentId)),
    updateKycDocumentReview: complianceProcedure.input(z.object({ documentId: z.string().uuid(), reviewStatus: z.enum(["under_review", "approved", "rejected", "expired"]), reviewNote: z.string().trim().min(4).max(4000) })).mutation(({ ctx, input }) => updatePostgresKycDocumentReview({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    complianceCases: auditorProcedure.query(() => listPostgresComplianceCases()),
    sarStrFilings: auditorProcedure.query(() => listPostgresSarStrFilings()),
    regulatoryReports: auditorProcedure.query(() => listPostgresRegulatoryReports()),
    regulatoryDeadlines: auditorProcedure.query(() => listPostgresRegulatoryDeadlines()),
    notificationDeliveries: auditorProcedure.query(() => listPostgresNotificationDeliveries()),
    documentAnalysisJobs: auditorProcedure.query(() => listPostgresDocumentAnalysisJobs()),
    documentAnalysisEvidence: auditorProcedure.query(() => listPostgresDocumentAnalysisEvidence()),
    reviewerDecisions: auditorProcedure.query(() => listPostgresReviewerDecisions()),
    activeVerificationConsents: auditorProcedure.query(() => listPostgresActiveVerificationConsents()),
    analysisReadyDocuments: auditorProcedure.query(() => listPostgresAnalysisReadyDocuments()),
    createVerificationConsent: complianceProcedure.input(z.object({ scope: z.enum(["kyc", "kyb"]), subjectReference: z.string().trim().min(3).max(255), consentVersion: z.string().trim().min(1).max(128), purpose: z.string().trim().min(10).max(1000), grantedAt: z.coerce.date(), expiresAt: z.coerce.date().optional() })).mutation(({ ctx, input }) => createPostgresVerificationConsent({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createDocumentAnalysisJob: complianceProcedure.input(z.object({ consentId: z.string().uuid(), kycDocumentId: z.string().uuid().optional(), caseKind: z.enum(["kyc", "kyb"]), documentClass: z.string().trim().min(3).max(128), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceUri: z.string().url(), mimeType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff"]) })).mutation(async ({ ctx, input }) => { const provenance = await resolveSelectedModel(input.mimeType); return createPostgresDocumentAnalysisJob({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, ...provenance }); }),
    persistDocumentAnalysisEvidence: complianceProcedure.input(z.object({ analysisJobId: z.string().uuid(), kind: z.enum(["ocr", "document_structure", "visual_consistency", "presentation_attack_risk", "engine_unavailable"]), disposition: z.enum(["review_required", "insufficient_evidence", "unavailable"]), engineName: z.string().trim().min(2).max(128), engineVersion: z.string().trim().min(1).max(128), modelTag: z.string().trim().max(128).optional(), modelDigest: z.string().trim().max(256).optional(), promptPolicyVersion: z.string().trim().max(128).optional(), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), signals: z.array(z.unknown()).max(100), limitations: z.array(z.string().trim().min(1).max(1200)).min(1).max(50) })).mutation(({ ctx, input }) => persistPostgresDocumentAnalysisEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createReviewerDecision: complianceProcedure.input(z.object({ analysisJobId: z.string().uuid(), disposition: z.enum(["approved", "rejected", "needs_information", "escalated"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => createPostgresReviewerDecision({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    disposeComplianceCase: complianceProcedure.input(z.object({ complianceCaseId: z.string().uuid(), status: z.enum(["under_review", "cleared", "escalated", "reported", "closed"]), decisionReason: z.string().trim().min(20).max(4000) })).mutation(({ ctx, input }) => disposeComplianceCase({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createComplianceCase: complianceProcedure.input(z.object({ caseType: z.enum(["kyc", "sanctions", "transaction_monitoring", "travel_rule", "counterparty", "sar_str"]), severity: z.enum(["low", "medium", "high", "critical"]), sourceReference: z.string().trim().min(4).max(512), decisionReason: z.string().trim().min(4).max(4000).optional() })).mutation(({ ctx, input }) => createPostgresComplianceCase({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createSarStrFiling: complianceOnlyProcedure.input(z.object({ complianceCaseId: z.string().uuid(), corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]), filingType: z.enum(["sar", "str"]), filingAuthority: z.string().trim().min(2).max(255), sourceReference: z.string().trim().min(4).max(512) })).mutation(({ ctx, input }) => createPostgresSarStrFiling({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    transitionSarStrFiling: complianceOnlyProcedure.input(z.object({ filingId: z.string().uuid(), status: z.enum(["under_review", "approved_for_submission", "pending_submission", "submitted", "submission_unavailable", "rejected"]), submissionReference: z.string().trim().min(1).max(255).optional() })).mutation(({ ctx, input }) => transitionPostgresSarStrFiling({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    registerLegalEntity: adminProcedure.input(z.object({ legalName: z.string().trim().min(3).max(255), jurisdiction: z.enum(["Nigeria", "Kenya", "South Africa"]), registrationIdentifier: z.string().trim().min(3).max(128) })).mutation(({ ctx, input }) => registerPostgresLegalEntity({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createRegulatoryReport: complianceProcedure.input(z.object({ regulator: z.enum(["CBN", "CBK", "SARB"]), corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]), reportType: z.string().trim().min(2).max(255), periodStart: z.coerce.date(), periodEnd: z.coerce.date(), legalEntityId: z.string().uuid() })).mutation(({ ctx, input }) => createPostgresRegulatoryReport({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    transitionRegulatoryReport: complianceProcedure.input(z.object({ reportId: z.string().uuid(), status: z.enum(["under_review", "approved", "pending_submission", "submitted", "rejected"]), statusReason: z.string().trim().min(4).max(4000), artifactUri: z.string().url().optional(), evidenceManifest: z.unknown().optional(), submissionReference: z.string().trim().min(1).max(255).optional() })).mutation(({ ctx, input }) => transitionPostgresRegulatoryReport({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordLiquidityPosition: treasuryProcedure.input(z.object({ corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]), currency: z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]), accountKind: z.enum(["liquidity_pool", "nostro", "vostro", "prefunding", "custody_wallet"]), accountReference: z.string().trim().min(2).max(255), availableAmount: z.string().trim().min(1).max(64), reservedAmount: z.string().trim().min(1).max(64), sourceReference: z.string().trim().min(4).max(512), reconciledAt: z.coerce.date() })).mutation(({ ctx, input }) => recordPostgresLiquidityPosition({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordMarketObservation: treasuryProcedure.input(z.object({ integrationConnectionId: z.string().uuid(), baseAsset: z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]), quoteAsset: z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]), rate: z.string().trim().min(1).max(64), observedAt: z.coerce.date(), sourceReference: z.string().url() }).refine(input => input.baseAsset !== input.quoteAsset, "The base and quote assets must differ")).mutation(({ ctx, input }) => recordPostgresMarketObservation({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    treasuryRecommendations: auditorProcedure.query(() => listPostgresTreasuryRecommendations()),
    treasuryBufferPolicies: auditorProcedure.query(() => listPostgresTreasuryBufferPolicies()),
    createTreasuryRecommendation: treasuryProcedure.input(z.object({ bufferPolicyId: z.string().uuid(), reconciledAvailableBalance: z.string().trim().min(1).max(64), reconciledAt: z.coerce.date(), balanceSourceReference: z.string().trim().min(4).max(512), verifiedNearTermFundingGap: z.string().trim().min(1).max(64), fundingGapSourceReference: z.string().trim().min(4).max(512), expiresAt: z.coerce.date() })).mutation(({ ctx, input }) => createPostgresTreasuryRecommendation({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    decideTreasuryRecommendation: treasuryProcedure.input(z.object({ recommendationId: z.string().uuid(), decision: z.enum(["approved", "rejected"]), decisionReason: z.string().trim().min(4).max(4000) })).mutation(({ ctx, input }) => decidePostgresTreasuryRecommendation({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createCounterpartyRiskAssessment: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), riskLevel: z.enum(["low", "medium", "high", "critical"]), riskScore: z.string().trim().min(1).max(32), riskFactors: z.unknown(), evidenceManifest: z.unknown(), assessedAt: z.coerce.date(), nextReviewAt: z.coerce.date() })).mutation(({ ctx, input }) => createPostgresCounterpartyRiskAssessment({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    escalateCounterpartyRiskAssessment: adminProcedure.input(z.object({ assessmentId: z.string().uuid(), reason: z.string().trim().min(4).max(4000) })).mutation(({ ctx, input }) => escalatePostgresCounterpartyRiskAssessment({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createCounterparty: adminProcedure.input(z.object({
      legalName: z.string().trim().min(2).max(255),
      counterpartyType: z.enum(["licensed_psp", "correspondent_bank", "stablecoin_provider", "fx_liquidity_provider", "custody_provider", "kyc_provider", "sanctions_provider", "chain_analytics_provider", "notification_provider", "regulatory_submission_provider"]),
      jurisdiction: z.string().trim().min(2).max(64),
    })).mutation(({ ctx, input }) => createPostgresCounterparty({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createCounterpartyAuthorization: adminProcedure.input(z.object({
      counterpartyId: z.string().uuid(),
      regulator: z.enum(["CBN", "CBK", "SARB", "SEC", "CMA", "FSCA", "FIC"]),
      licenceReference: z.string().trim().min(1).max(255),
      scopeDescription: z.string().trim().min(10),
      evidenceUri: z.string().url(),
      validFrom: z.coerce.date(),
      validTo: z.coerce.date().optional(),
      status: z.enum(["pending_review", "verified", "expired", "suspended", "rejected"]).default("pending_review"),
    })).mutation(({ ctx, input }) => createPostgresCounterpartyAuthorization({ openId: ctx.user.openId, role: ctx.user.role }, input)),
  }),
  contracts: router({
    parseGoPaymentOrderValidated: complianceProcedure.input(z.unknown()).mutation(({ input }) => parseGoPaymentOrderValidatedEvent(input)),
    parseRustPolicyDecision: complianceProcedure.input(z.unknown()).mutation(({ input }) => parseRustNonExecutablePolicyDecisionEvent(input)),
    parsePythonBronzeManifest: complianceProcedure.input(z.unknown()).mutation(({ input }) => parsePythonBronzeBatchManifest(input)),
    // Versioned service-boundary contracts. Parsing is provider-independent and
    // never authorises execution; see docs/service-contracts.md.
    parseGoAuditTrail: complianceProcedure.input(z.unknown()).mutation(({ input }) => parseGoAuditTrailEnvelope(input)),
    parseRustMonitoringResult: complianceProcedure.input(z.unknown()).mutation(({ input }) => parseRustMonitoringResult(input)),
    parseRustCounterpartyRisk: complianceProcedure.input(z.unknown()).mutation(({ input }) => parseRustCounterpartyRisk(input)),
    parsePythonAssembledReport: complianceProcedure.input(z.unknown()).mutation(({ input }) => parsePythonAssembledReport(input)),
    parsePythonStablecoinExposure: complianceProcedure.input(z.unknown()).mutation(({ input }) => parsePythonStablecoinExposure(input)),
    parseRustLedgerValidation: complianceProcedure.input(z.unknown()).mutation(({ input }) => parseRustLedgerValidation(input)),
    parseRustLedgerReconciliation: complianceProcedure.input(z.unknown()).mutation(({ input }) => parseRustLedgerReconciliation(input)),
    // Live service bridge. Each call is contract-validated and fails closed; see
    // server/serviceBridge.ts and docs/service-contracts.md.
    serviceConfiguration: auditorProcedure.query(() => describeServiceConfiguration()),
    evaluateMonitoringViaService: complianceProcedure
      .input(monitoringInputSchema)
      .mutation(({ input }) => evaluateMonitoringViaService(input)),
    assessCounterpartyRiskViaService: complianceProcedure
      .input(counterpartyRiskInputSchema)
      .mutation(({ input }) => assessCounterpartyRiskViaService(input)),
    // Ledger-gateway verification. Neither call can post to TigerBeetle or write
    // to PostgreSQL: the gateway holds no database client, and both responses are
    // independently re-derived by their contract parsers before being returned.
    validateLedgerPostingsViaService: complianceProcedure
      .input(z.array(ledgerPostingSchema).min(1))
      .mutation(({ input }) => validateLedgerPostingsViaService(input)),
    reconcileLedgerProjectionViaService: complianceProcedure
      .input(ledgerReconciliationInputSchema)
      .mutation(({ input }) => reconcileLedgerProjectionViaService(input)),
  }),
  umoja: umojaFlowRouter,
});

export type AppRouter = typeof appRouter;
