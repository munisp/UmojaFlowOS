import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";
import { probeProviderEndpoint } from "./providerHealthCheck";
import { collectAllServiceStatuses } from "./serviceHealth";
import { listServiceHealthHistory, recordServiceHealthSamples, summariseServiceAvailability } from "./serviceHealthHistory";
import { evaluateServiceHealthSlo } from "./serviceHealthSlo";
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
import { adminProcedure, assuranceVerifierProcedure, auditorProcedure, cbnLiaisonProcedure, complianceOnlyProcedure, complianceProcedure, providerContactProcedure, publicProcedure, router, treasuryProcedure } from "./_core/trpc";
import { listPostgresActiveVerificationConsents, listPostgresAnalysisReadyDocuments } from "./analysisSubmission";
import { registerPostgresLegalEntity } from "./legalEntityRegistry";
import { disposeComplianceCase } from "./complianceCaseWorkflow";
import { beginCounterpartyRecertification, createCounterpartyOnboarding, decideCounterpartyOnboardingGate, listCounterpartyOnboardings } from "./counterpartyOnboarding";
import { assessCbnSandboxEvidenceCompleteness, createCbnSandboxDossier, createCbnSandboxReportingPack, createCbnSandboxTestPlan, getCbnSandboxReadiness, latestCbnSandboxEvidenceAssessment, listCbnSandboxDossiers, recordCbnSandboxConsumerRecord, recordCbnSandboxEvidence, recordCbnSandboxIncident } from "./cbnSandbox";
import { assessVaspOffshoreCounterpartyProfile, assessVaspTravelRuleRoute, createVaspOffshoreCounterpartyProfile, createVaspRegulatoryProfile, getVaspSupervisoryReadiness, listVaspRegulatoryProfiles, listVaspTravelRuleAssessments, offshoreExposureEvidenceCategories, recordVaspOffshoreCounterpartyEvidence, recordVaspSupervisoryEvidence, recordVaspTravelRuleEvidence, supervisoryEvidenceCategories, travelRuleEvidenceCategories } from "./vaspReadiness";
import { assessImtoReadiness, createImtoReadinessProfile, imtoEvidenceCategories, recordImtoReadinessEvidence } from "./imtoReadiness";
import { assessReadinessAssurance, initialiseReadinessAssurance, listReadinessAssurance, readinessAssuranceAreas, recordReadinessAssuranceEvidence, rejectReadinessAssuranceEvidence, verifyReadinessAssuranceEvidence } from "./vaspReadinessAssurance";
import { assignExternalStakeholder, listCbnLiaisonAssignments, listProviderContactAssignments, recordExternalStakeholderEvidence } from "./externalStakeholders";
import { resolveSelectedModel } from "./modelProvenance";
import { transitionPostgresPaymentLeg, createPostgresPaymentLeg, createPostgresPaymentOrder, expirePostgresRateLocks, listPostgresPaymentLegs, listPostgresPaymentOrders, transitionPostgresPaymentOrder } from "./paymentWorkflow";
import { listPostgresTreasuryRecommendations, listPostgresTreasuryBufferPolicies, listPostgresLegalEntities, transitionPostgresCounterpartyAuthorization, evaluatePostgresRegulatoryDeadlines, cancelPostgresRateLock, createPostgresAlertPolicy, createPostgresBeneficiary, createPostgresComplianceCase, createPostgresCorridorPolicy, createPostgresCounterparty, createPostgresCounterpartyAuthorization, createPostgresCounterpartyRiskAssessment, createPostgresCustomer, createPostgresDocumentAnalysisJob, createPostgresIntegrationConnection, createPostgresKycDocumentUploadIntent, createPostgresRateLock, createPostgresRegulatoryDeadline, createPostgresRegulatoryReport, createPostgresReviewerDecision, createPostgresSarStrFiling, createPostgresTreasuryRecommendation, createPostgresVerificationConsent, decidePostgresTreasuryRecommendation, escalatePostgresCounterpartyRiskAssessment, finalizePostgresKycDocumentUpload, getPostgresCutoverReadiness, getPostgresDashboardSnapshot, getPostgresReadiness, listPostgresAlertPolicies, listPostgresBeneficiaries, listPostgresComplianceCases, listPostgresCorridorPolicies, listPostgresCounterparties, listPostgresCounterpartyAuthorizations, listPostgresCounterpartyRiskAssessments, listPostgresCustomers, listPostgresDocumentAnalysisEvidence, listPostgresDocumentAnalysisJobs, listPostgresIntegrationConnections, listPostgresKycDocuments, listPostgresLiquidityPositions, listPostgresMarketObservations, listPostgresNotificationDeliveries, listPostgresRateLocks, listPostgresRegulatoryDeadlines, listPostgresRegulatoryReports, listPostgresReviewerDecisions, listPostgresSarStrFilings, persistPostgresDocumentAnalysisEvidence, recordPostgresBeneficiaryScreening, recordPostgresLiquidityPosition, recordPostgresMarketObservation, transitionPostgresRegulatoryReport, transitionPostgresSarStrFiling, updatePostgresKycDocumentReview } from "./postgres";
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
import { legacyOperatingRoles, type OperatingRole } from "./operatingRoles";

type LegacyOperatingRole = Exclude<OperatingRole, "provider_contact" | "cbn_liaison">;
function legacyActor(user: { openId: string; role: OperatingRole }): { openId: string; role: LegacyOperatingRole } {
  if (!legacyOperatingRoles.has(user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "External stakeholder roles cannot access this internal operational procedure." });
  return { openId: user.openId, role: user.role as LegacyOperatingRole };
}

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
    dashboardSnapshot: auditorProcedure.query(() => getPostgresDashboardSnapshot()),
    cutoverReadiness: auditorProcedure.query(() => getPostgresCutoverReadiness()),
    cbnSandboxDossiers: auditorProcedure.query(() => listCbnSandboxDossiers()),
    vaspRegulatoryProfiles: auditorProcedure.query(() => listVaspRegulatoryProfiles()),
    vaspTravelRuleAssessments: auditorProcedure.input(z.object({ dossierId: z.string().uuid().optional() }).optional()).query(({ input }) => listVaspTravelRuleAssessments(input?.dossierId)),
    vaspSupervisoryReadiness: auditorProcedure.input(z.object({ profileId: z.string().uuid() })).query(({ input }) => getVaspSupervisoryReadiness(input.profileId)),
    createImtoReadinessProfile: adminProcedure.input(z.object({ legalEntityId: z.string().uuid(), operatingModelSummary: z.string().trim().min(50).max(4000) })).mutation(({ ctx,input }) => createImtoReadinessProfile({ openId: ctx.user.openId, role: ctx.user.role },input)),
    recordImtoReadinessEvidence: complianceProcedure.input(z.object({ profileId: z.string().uuid(), category: z.enum(imtoEvidenceCategories), evidenceUri: z.string().url().refine(value => value.startsWith("https://"), "Evidence must use HTTPS"), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(({ ctx,input }) => recordImtoReadinessEvidence({ openId: ctx.user.openId, role: ctx.user.role },input)),
    assessImtoReadiness: complianceProcedure.input(z.object({ profileId: z.string().uuid(), reviewerRationale: z.string().trim().min(20).max(4000) })).mutation(({ ctx,input }) => assessImtoReadiness({ openId: ctx.user.openId, role: ctx.user.role },input)),
    createVaspRegulatoryProfile: adminProcedure.input(z.object({ dossierId: z.string().uuid(), supervisoryPath: z.enum(["sec_arip", "sec_full_registration", "other_supervisory_path"]), operationalModelSummary: z.string().trim().min(50).max(4000) })).mutation(({ ctx, input }) => createVaspRegulatoryProfile({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    initialiseReadinessAssurance: adminProcedure.input(z.object({ dossierId: z.string().uuid() })).mutation(({ ctx, input }) => initialiseReadinessAssurance({ openId: ctx.user.openId, role: ctx.user.role }, input.dossierId)),
    readinessAssurance: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => listReadinessAssurance(input.dossierId)),
    assessReadinessAssurance: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => assessReadinessAssurance(input.dossierId)),
    recordReadinessAssuranceEvidence: complianceProcedure.input(z.object({ dossierId: z.string().uuid(), area: z.enum(readinessAssuranceAreas), evidenceUri: z.string().url().refine(value => value.startsWith("https://"), "Evidence must use HTTPS"), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(({ ctx, input }) => recordReadinessAssuranceEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    verifyReadinessAssuranceEvidence: assuranceVerifierProcedure.input(z.object({ dossierId: z.string().uuid(), area: z.enum(readinessAssuranceAreas), externalVerifier: z.string().trim().min(3).max(255), externalAttestationUri: z.string().url().refine(value => value.startsWith("https://"), "Attestation must use HTTPS"), externalAttestationSha256: z.string().regex(/^[a-f0-9]{64}$/), rationale: z.string().trim().min(20).max(4000) })).mutation(({ ctx, input }) => verifyReadinessAssuranceEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    rejectReadinessAssuranceEvidence: assuranceVerifierProcedure.input(z.object({ dossierId: z.string().uuid(), area: z.enum(readinessAssuranceAreas), rationale: z.string().trim().min(20).max(4000) })).mutation(({ ctx, input }) => rejectReadinessAssuranceEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordVaspSupervisoryEvidence: complianceProcedure.input(z.object({ profileId: z.string().uuid(), category: z.enum(supervisoryEvidenceCategories), evidenceUri: z.string().url().refine(value => value.startsWith("https://"), "Evidence must use HTTPS"), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(({ ctx, input }) => recordVaspSupervisoryEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordVaspTravelRuleEvidence: complianceProcedure.input(z.object({ dossierId: z.string().uuid(), counterpartyId: z.string().uuid(), category: z.enum(travelRuleEvidenceCategories), evidenceUri: z.string().url().refine(value => value.startsWith("https://"), "Evidence must use HTTPS"), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(({ ctx, input }) => recordVaspTravelRuleEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    assessVaspTravelRuleRoute: complianceProcedure.input(z.object({ dossierId: z.string().uuid(), counterpartyId: z.string().uuid(), reviewerRationale: z.string().trim().min(20).max(4000) })).mutation(({ ctx, input }) => assessVaspTravelRuleRoute({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createVaspOffshoreCounterpartyProfile: adminProcedure.input(z.object({ dossierId: z.string().uuid(), counterpartyId: z.string().uuid(), homeJurisdiction: z.string().trim().min(2).max(120), exposureTier: z.enum(["standard", "heightened", "prohibited_review"]), operatingSummary: z.string().trim().min(50).max(4000) })).mutation(({ ctx, input }) => createVaspOffshoreCounterpartyProfile({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordVaspOffshoreCounterpartyEvidence: complianceProcedure.input(z.object({ profileId: z.string().uuid(), category: z.enum(offshoreExposureEvidenceCategories), evidenceUri: z.string().url().refine(value => value.startsWith("https://"), "Evidence must use HTTPS"), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(({ ctx, input }) => recordVaspOffshoreCounterpartyEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    assessVaspOffshoreCounterpartyProfile: complianceProcedure.input(z.object({ profileId: z.string().uuid(), reviewerRationale: z.string().trim().min(20).max(4000) })).mutation(({ ctx, input }) => assessVaspOffshoreCounterpartyProfile({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    cbnSandboxReadiness: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => getCbnSandboxReadiness(input.dossierId)),
    cbnSandboxLatestEvidenceAssessment: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => latestCbnSandboxEvidenceAssessment(input.dossierId)),
    createCbnSandboxDossier: adminProcedure.input(z.object({ legalEntityId: z.string().uuid(), track: z.enum(["vasp", "data_enabled_non_vasp"]), productName: z.string().trim().min(3).max(255), productSummary: z.string().trim().min(50).max(4000) })).mutation(({ ctx, input }) => createCbnSandboxDossier({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordCbnSandboxEvidence: complianceProcedure.input(z.object({ dossierId: z.string().uuid(), category: z.enum(["corporate_governance", "ownership", "financial_capacity", "aml_cft_cpf", "consumer_protection", "cybersecurity", "data_protection", "operational_resilience", "business_continuity", "stablecoin_governance", "reserve_attestation", "redemption", "custody_key_management", "third_party_oversight", "testing_plan"]), evidenceUri: z.string().url().refine(value => value.startsWith("https://"), "Evidence must use HTTPS"), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(({ ctx, input }) => recordCbnSandboxEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    assessCbnSandboxEvidenceCompleteness: complianceProcedure.input(z.object({ dossierId: z.string().uuid(), reviewerRationale: z.string().trim().min(20).max(4000) })).mutation(({ ctx, input }) => assessCbnSandboxEvidenceCompleteness({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createCbnSandboxTestPlan: adminProcedure.input(z.object({ dossierId: z.string().uuid(), permittedUse: z.string().trim().min(20).max(1000), userCategory: z.string().trim().min(3).max(255), maxTransactions: z.number().int().positive().max(1_000_000), maxAggregateExposure: z.string().regex(/^\d+(\.\d{1,12})?$/), startsAt: z.coerce.date(), endsAt: z.coerce.date(), successMetricsUri: z.string().url().refine(value => value.startsWith("https://"), "Metrics evidence must use HTTPS"), windDownUri: z.string().url().refine(value => value.startsWith("https://"), "Wind-down evidence must use HTTPS") }).refine(input => input.endsAt > input.startsAt, "Test end must follow its start")).mutation(({ ctx, input }) => createCbnSandboxTestPlan({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordCbnSandboxConsumerRecord: complianceProcedure.input(z.object({ dossierId: z.string().uuid(), customerId: z.string().uuid(), recordKind: z.enum(["disclosure_acceptance", "complaint"]), disclosureVersion: z.string().trim().min(1).max(128).optional(), evidenceUri: z.string().url().refine(value => value.startsWith("https://"), "Evidence must use HTTPS"), details: z.string().trim().min(10).max(4000) }).superRefine((input, context) => { if (input.recordKind === "disclosure_acceptance" && !input.disclosureVersion) context.addIssue({ code: "custom", message: "A disclosure version is required for an acceptance record", path: ["disclosureVersion"] }); })).mutation(({ ctx, input }) => recordCbnSandboxConsumerRecord({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordCbnSandboxIncident: complianceProcedure.input(z.object({ dossierId: z.string().uuid(), kind: z.enum(["cybersecurity", "fraud", "consumer_harm", "operational_resilience"]), severity: z.enum(["low", "medium", "high", "critical"]), occurredAt: z.coerce.date(), detectedAt: z.coerce.date(), evidenceUri: z.string().url().refine(value => value.startsWith("https://"), "Evidence must use HTTPS"), summary: z.string().trim().min(20).max(4000) }).refine(input => input.detectedAt >= input.occurredAt, "Detection cannot precede occurrence")).mutation(({ ctx, input }) => recordCbnSandboxIncident({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createCbnSandboxReportingPack: complianceProcedure.input(z.object({ dossierId: z.string().uuid(), periodStart: z.coerce.date(), periodEnd: z.coerce.date(), artifactUri: z.string().url().refine(value => value.startsWith("https://"), "Artifact must use HTTPS") }).refine(input => input.periodEnd > input.periodStart, "Reporting period end must follow its start")).mutation(({ ctx, input }) => createCbnSandboxReportingPack({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    assignExternalStakeholder: adminProcedure.input(z.object({ role: z.enum(["provider_contact", "cbn_liaison"]), stakeholderSubject: z.string().trim().min(3).max(255), counterpartyId: z.string().uuid().optional(), dossierId: z.string().uuid().optional() }).superRefine((input, context) => { if ((input.role === "provider_contact") !== Boolean(input.counterpartyId) || (input.role === "cbn_liaison") !== Boolean(input.dossierId)) context.addIssue({ code: "custom", message: "assignment subject must match the stakeholder role" }); })).mutation(({ ctx, input }) => assignExternalStakeholder({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    providerContactAssignments: providerContactProcedure.query(({ ctx }) => listProviderContactAssignments(ctx.user.openId)),
    cbnLiaisonAssignments: cbnLiaisonProcedure.query(({ ctx }) => listCbnLiaisonAssignments(ctx.user.openId)),
    recordProviderContactEvidence: providerContactProcedure.input(z.object({ assignmentId: z.string().uuid(), category: z.enum(["provider_licensing", "product_entitlement", "technical_endpoint", "callback_configuration", "operating_runbook"]), evidenceUri: z.string().url().refine(value => value.startsWith("https://"), "Evidence must use HTTPS"), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(({ ctx, input }) => recordExternalStakeholderEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordCbnLiaisonEvidence: cbnLiaisonProcedure.input(z.object({ assignmentId: z.string().uuid(), category: z.enum(["application_correspondence", "review_request", "review_response"]), evidenceUri: z.string().url().refine(value => value.startsWith("https://"), "Evidence must use HTTPS"), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(({ ctx, input }) => recordExternalStakeholderEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    counterparties: auditorProcedure.query(() => listPostgresCounterparties()),
    counterpartyOnboardings: auditorProcedure.query(() => listCounterpartyOnboardings()),
    createCounterpartyOnboarding: adminProcedure.input(z.object({
      counterpartyId: z.string().uuid(),
      countryOverlays: z.array(z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"])).min(1).max(3),
      legalEvidenceUri: z.string().url(),
      recertificationDueAt: z.coerce.date(),
    })).mutation(({ ctx, input }) => createCounterpartyOnboarding({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    decideCounterpartyOnboardingGate: complianceOnlyProcedure.input(z.object({
      onboardingId: z.string().uuid(),
      gate: z.enum(["legal", "pilot"]),
      decision: z.enum(["approved", "blocked"]),
      evidenceUri: z.string().url(),
      rationale: z.string().trim().min(10).max(4000),
    })).mutation(({ ctx, input }) => decideCounterpartyOnboardingGate({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    decideTechnicalOnboardingGate: adminProcedure.input(z.object({
      onboardingId: z.string().uuid(),
      decision: z.enum(["approved", "blocked"]),
      evidenceUri: z.string().url(),
      rationale: z.string().trim().min(10).max(4000),
    })).mutation(({ ctx, input }) => decideCounterpartyOnboardingGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "technical" })),
    decideTreasuryPilotOnboardingGate: treasuryProcedure.input(z.object({
      onboardingId: z.string().uuid(),
      decision: z.enum(["approved", "blocked"]),
      evidenceUri: z.string().url(),
      rationale: z.string().trim().min(10).max(4000),
    })).mutation(({ ctx, input }) => decideCounterpartyOnboardingGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "pilot" })),
    beginCounterpartyRecertification: complianceProcedure.input(z.object({
      onboardingId: z.string().uuid(),
      legalEvidenceUri: z.string().url(),
      recertificationDueAt: z.coerce.date(),
    })).mutation(({ ctx, input }) => beginCounterpartyRecertification({ openId: ctx.user.openId, role: ctx.user.role }, input.onboardingId, input.legalEvidenceUri, input.recertificationDueAt)),
    customers: auditorProcedure.query(() => listPostgresCustomers()),
    beneficiaries: auditorProcedure.input(z.object({ customerId: z.string().uuid().optional() }).optional()).query(({ input }) => listPostgresBeneficiaries(input?.customerId)),
    createCustomer: complianceProcedure.input(z.object({ legalName: z.string().trim().min(2).max(255), registrationIdentifier: z.string().trim().min(2).max(255) })).mutation(({ ctx, input }) => createPostgresCustomer({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createBeneficiary: complianceProcedure.input(z.object({ customerId: z.string().uuid(), legalName: z.string().trim().min(2).max(255), countryCode: z.string().trim().length(2).toUpperCase(), bankOrWalletReference: z.string().trim().min(4).max(512) })).mutation(({ ctx, input }) => createPostgresBeneficiary({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordBeneficiaryScreening: complianceProcedure.input(z.object({ beneficiaryId: z.string().uuid(), integrationConnectionId: z.string().uuid(), correlationId: z.string().trim().min(8).max(255), screeningState: z.enum(["clear", "potential_match", "confirmed_match", "source_unavailable"]), providerReference: z.string().trim().min(3).max(512), sourceVersion: z.string().trim().min(1).max(255), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/), screenedAt: z.coerce.date().refine(value => value <= new Date(), "Screening time cannot be in the future") })).mutation(({ ctx, input }) => recordPostgresBeneficiaryScreening({ openId: ctx.user.openId, role: ctx.user.role }, input)),
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
     * A measured resilience SLO report. A missing or sparse sample set remains
     * `insufficient_evidence`, never a synthetic passing result.
     */
    serviceHealthSlo: auditorProcedure
      .input(z.object({
        sinceMinutes: z.number().int().min(60).max(43200).optional(),
        targetAvailability: z.number().min(0.9).max(1).optional(),
        minimumSamples: z.number().int().min(1).max(20000).optional(),
      }).optional())
      .query(({ input }) => evaluateServiceHealthSlo(input ?? {})),

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
    expireRateLocks: treasuryProcedure.mutation(({ ctx }) => expirePostgresRateLocks(legacyActor(ctx.user))),
    createPaymentOrder: treasuryProcedure
      .input(z.object({ idempotencyKey: z.string().min(8).max(120), customerId: z.string().uuid(), beneficiaryId: z.string().uuid(), rateLockId: z.string().uuid(), sourceAmount: z.string().regex(/^\d+(\.\d{1,8})?$/) }))
      .mutation(({ ctx, input }) => createPostgresPaymentOrder(legacyActor(ctx.user), input)),
    createPaymentLeg: treasuryProcedure
      .input(z.object({ paymentOrderId: z.string().uuid(), sequenceNumber: z.number().int().min(1).max(20), legKind: z.string().min(3).max(60), counterpartyId: z.string().uuid() }))
      .mutation(({ ctx, input }) => createPostgresPaymentLeg(legacyActor(ctx.user), input)),
    transitionPaymentOrder: treasuryProcedure
      .input(z.object({ paymentOrderId: z.string().uuid(), status: z.enum(["pending_policy_decision", "blocked", "manual_review", "approved", "cancelled"]), reason: z.string().min(10).max(2000) }))
      .mutation(({ ctx, input }) => transitionPostgresPaymentOrder(legacyActor(ctx.user), input)),
    transitionPaymentLeg: treasuryProcedure
      .input(z.object({ paymentLegId: z.string().uuid(), status: z.enum(["pending_policy_decision", "blocked", "manual_review", "approved", "cancelled"]), reason: z.string().min(10).max(2000) }))
      .mutation(({ ctx, input }) => transitionPostgresPaymentLeg(legacyActor(ctx.user), input)),
    createRateLock: treasuryProcedure.input(z.object({ marketObservationId: z.string().uuid(), corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]), expiresAt: z.coerce.date() })).mutation(({ ctx, input }) => createPostgresRateLock(legacyActor(ctx.user), input)),
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
    createSarStrFiling: complianceOnlyProcedure.input(z.object({ complianceCaseId: z.string().uuid(), corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]), filingType: z.enum(["sar", "str"]), filingAuthority: z.string().trim().min(2).max(255), sourceReference: z.string().trim().min(4).max(512) })).mutation(({ ctx, input }) => createPostgresSarStrFiling(legacyActor(ctx.user), input)),
    transitionSarStrFiling: complianceOnlyProcedure.input(z.object({ filingId: z.string().uuid(), status: z.enum(["under_review", "approved_for_submission", "pending_submission", "submitted", "submission_unavailable", "rejected"]), submissionReference: z.string().trim().min(1).max(255).optional() })).mutation(({ ctx, input }) => transitionPostgresSarStrFiling({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    registerLegalEntity: adminProcedure.input(z.object({ legalName: z.string().trim().min(3).max(255), jurisdiction: z.enum(["Nigeria", "Kenya", "South Africa"]), registrationIdentifier: z.string().trim().min(3).max(128) })).mutation(({ ctx, input }) => registerPostgresLegalEntity(legacyActor(ctx.user), input)),
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
});

export type AppRouter = typeof appRouter;
