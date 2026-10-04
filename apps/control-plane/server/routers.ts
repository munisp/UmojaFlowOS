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
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, assuranceVerifierProcedure, auditorProcedure, cbnLiaisonProcedure, complianceOnlyProcedure, complianceOrTreasuryProcedure, complianceProcedure, providerContactProcedure, publicProcedure, router, treasuryProcedure } from "./_core/trpc";
import { listPostgresActiveVerificationConsents, listPostgresAnalysisReadyDocuments } from "./analysisSubmission";
import { registerPostgresLegalEntity } from "./legalEntityRegistry";
import { disposeComplianceCase } from "./complianceCaseWorkflow";
import { beginCounterpartyRecertification, createCounterpartyOnboarding, decideCounterpartyOnboardingGate, listCounterpartyOnboardings } from "./counterpartyOnboarding";
import { assessCbnSandboxEvidenceCompleteness, createCbnSandboxDossier, createCbnSandboxReportingPack, createCbnSandboxTestPlan, getCbnSandboxReadiness, latestCbnSandboxEvidenceAssessment, listCbnSandboxDossiers, recordCbnSandboxConsumerRecord, recordCbnSandboxEvidence, recordCbnSandboxIncident } from "./cbnSandbox";
import { assessVaspOffshoreCounterpartyProfile, assessVaspTravelRuleRoute, createVaspOffshoreCounterpartyProfile, createVaspRegulatoryProfile, getVaspSupervisoryReadiness, listVaspRegulatoryProfiles, listVaspTravelRuleAssessments, offshoreExposureEvidenceCategories, recordVaspOffshoreCounterpartyEvidence, recordVaspSupervisoryEvidence, recordVaspTravelRuleEvidence, supervisoryEvidenceCategories, travelRuleEvidenceCategories } from "./vaspReadiness";
import { assessImtoReadiness, createImtoReadinessProfile, imtoEvidenceCategories, recordImtoReadinessEvidence } from "./imtoReadiness";
import { assessReadinessAssurance, initialiseReadinessAssurance, listReadinessAssurance, readinessAssuranceAreas, recordReadinessAssuranceEvidence, rejectReadinessAssuranceEvidence, verifyReadinessAssuranceEvidence } from "./vaspReadinessAssurance";
import { validateVaspEvidenceManifestAgainstRegister, validateVaspOwnerAssignmentsAgainstRegister } from "./vaspEvidenceKitValidation";
import { auditVaspEvidenceIntegrity, computeVaspAssuranceEvidenceChain, computeVaspReadinessIndex, detectVaspIncidentPatterns, evaluateVaspEvidenceStaleness, evaluateVaspOffshoreExposureConcentration, generateVaspAssurancePack, planVaspRegulatoryCriticalPath, scanVaspSodConflicts, scoreVaspTravelRuleRoute } from "./vaspInnovations";
import { assignExternalStakeholder, listCbnLiaisonAssignments, listProviderContactAssignments, recordExternalStakeholderEvidence } from "./externalStakeholders";
import { decideCustomerUseCaseGate, getCustomerWorkspace, recordCustomerDestinationCounterparty, updatePostgresCustomerProfile } from "./customerUseCase";
import { decideFinancialSoundnessGate, getLiquidityProviderWorkspace, listLiquidityProviders, recordCounterpartyEvidenceItem, updateCounterpartyLpArchetype } from "./liquidityProviderEvidence";
import { decideCryptoPostureGate, getBankingPartnerWorkspace, listBankingPartners, recordBankEvidenceItem, updateCounterpartyBankArchetype } from "./bankingPartnerEvidence";
import { decidePspGate, getPayoutPspWorkspace, listPayoutPsps, recordPspEvidenceItem, updateCounterpartyPspArchetype } from "./payoutPspEvidence";
import { decideStablecoinIssuerGate, getStablecoinIssuerWorkspace, listStablecoinIssuers, recordStablecoinIssuerEvidenceItem, updateCounterpartyStablecoinIssuerArchetype } from "./stablecoinIssuerEvidence";
import { decideComplianceVendorGate, getComplianceVendorWorkspace, listComplianceVendors, recordComplianceVendorEvidenceItem, updateCounterpartyComplianceVendorArchetype } from "./complianceVendorEvidence";
import { changeOperatorRole, deactivateOperator, listOperators } from "./operatorDirectory";
import { listOperatorOnboardingRecords, recordLmsEnrolment, recordOperatorRecertification, recordShadowPeriodSupervision, recordSodMatrixReview, startOperatorOnboarding } from "./operatorOnboardingLifecycle";
import { listAuditorEngagements, recordAccessProvisioning, recordAnnualReview, recordAuditFieldwork, recordEngagementLetter, startAuditorEngagement } from "./auditorEngagementLifecycle";
import { listOperatorAccessRequests } from "./operatorAccessRequests";
import { grantOperatingRole } from "./operatorRoleGrants";
import { onboardOperator } from "./operatorOnboarding";
import { operatorAccountCreationAvailable } from "./keycloakAdmin";
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
import {
  requestStakeholderAccount, decideAdministratorApproval, transitionStakeholderAccount,
  listStakeholderAccounts, assignSuperAdministrator, revokeSuperAdministrator, listSuperAdministrators,
  listAdministratorGovernanceAudit, revokeStakeholderSession, listStakeholderSessions,
  upsertNotificationPreferences, getNotificationPreferences, listSecurityMessages, listKycReminderDeliveries,
} from "./stakeholderAccounts";
import {
  getAdministratorKycUploadPolicy, updateAdministratorKycUploadPolicy, listAdministratorKycUploadPolicyAudit,
  createAdministratorKycUploadIntent, finalizeAdministratorKycUploadIntent, recordAdministratorKycOversizeException,
  submitAdministratorKycEvidence, recordAdministratorKycReview, createAdministratorKycEvidenceRequest,
  transitionAdministratorKycEvidenceRequest, raiseAdministratorKycEscalation, recordAdministratorKycReviewEntry,
  getAdministratorKycWorkspace, ADMIN_KYC_EVIDENCE_KINDS, ADMIN_KYC_JURISDICTIONS,
} from "./administratorKyc";
import {
  createTradeCase, transitionTradeCase, assignTradeCaseStakeholder, revokeTradeCaseStakeholder,
  submitTradeCaseEvidence, reviewTradeCaseEvidence, configureTradeCaseRoute, transitionTradeCaseRoute,
  recordTradeCaseApproval, raiseTradeCaseException, resolveTradeCaseException, recordTradeCaseReconciliation,
  listTradeCases, getTradeCaseWorkspace, TRADE_EVIDENCE_KINDS, TRADE_STAKEHOLDER_ROLES, TRADE_APPROVAL_ROLES,
} from "./tradePaymentControl";
import {
  registerGovernedBankAccount, recordLiquidityGovernancePolicy, recordStablecoinTreasuryMandate,
  registerSupplyChainFinanceProgramme, registerSpendCardProgramme, recordSpendPolicyRule,
  recordEnterpriseGovernanceReview, getEnterpriseGovernanceWorkspace, listSpendPolicyRules,
} from "./enterpriseGovernance";
import {
  recordControlAssuranceAssessment, recordAdapterCertificationEvidence, recordControlAuditPacket,
  listControlAssuranceAssessments, listAdapterCertificationEvidence, listControlAuditPackets,
  ASSURANCE_KINDS, ADAPTER_KINDS, PACKET_SCOPES,
} from "./controlAssuranceHub";
import {
  configureStablecoinOrchestrationRoute, reviewStablecoinOrchestrationRoute, listStablecoinOrchestrationRoutes,
  recordAuthorisedExecutionTest, recordExecutionApprovalRehearsal, listExecutionApprovalRehearsals,
  recordStablecoinExecutionEvidence, listStablecoinExecutionEvidence,
  recordStablecoinSettlementAttempt, listStablecoinSettlementAttempts,
} from "./executionRehearsal";
import {
  recordLedgerPostingIntent, transitionLedgerPostingIntent, recordLedgerReconciliationRun,
  recordLedgerReconciliationDiscrepancy, listLedgerPostingIntents, listLedgerReconciliationRuns,
  listLedgerReconciliationDiscrepancies,
} from "./ledgerReconciliation";
import {
  recordProviderSendRequest, transitionProviderSendRequest, listProviderSendRequests,
  recordRegulatorySubmissionAttempt, listRegulatorySubmissionAttempts,
} from "./liveControlPipelines";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, "must be 64 lowercase hex chars");
const httpsUri = z.string().url().refine(v => v.startsWith("https://"), "must use HTTPS");
const rationale = z.string().trim().min(16).max(4000);
const uuid = z.string().uuid();

type LegacyOperatingRole = Exclude<OperatingRole, "provider_contact" | "cbn_liaison">;
function legacyActor(user: { openId: string; role: OperatingRole }): { openId: string; role: LegacyOperatingRole } {
  if (!legacyOperatingRoles.has(user.role)) throw new TRPCError({ code: "FORBIDDEN", message: "External stakeholder roles cannot access this internal operational procedure." });
  return { openId: user.openId, role: user.role as LegacyOperatingRole };
}

export const appRouter = router({
  system: systemRouter,
  auth: router({
    me: publicProcedure.query(opts => opts.ctx.user),
    pendingAccessStatus: publicProcedure.query(opts => opts.ctx.pendingIdentity),
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
    validateVaspOwnerAssignments: auditorProcedure.input(z.object({
      dossierId: z.string().uuid(),
      assignments: z.array(z.object({
        area: z.string(),
        points: z.number().int(),
        accountableRole: z.string(),
        externalEvidenceOwner: z.string(),
        externalContact: z.string(),
        platformSubmitterSubject: z.string(),
        platformVerifierSubject: z.string(),
      })).min(1).max(6),
    })).query(({ input }) => validateVaspOwnerAssignmentsAgainstRegister(input.dossierId, input.assignments)),
    validateVaspEvidenceManifest: auditorProcedure.input(z.object({
      dossierId: z.string().uuid(),
      manifest: z.array(z.object({
        area: z.string(),
        evidenceUri: z.string(),
        evidenceSha256: z.string(),
        attestationUri: z.string().optional(),
        attestationSha256: z.string().optional(),
      })).min(1).max(6),
    })).query(({ input }) => validateVaspEvidenceManifestAgainstRegister(input.dossierId, input.manifest)),
    vaspEvidenceStaleness: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => evaluateVaspEvidenceStaleness(input.dossierId)),
    vaspAssuranceEvidenceChain: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => computeVaspAssuranceEvidenceChain(input.dossierId)),
    vaspTravelRuleRouteScore: auditorProcedure.input(z.object({ dossierId: z.string().uuid(), counterpartyId: z.string().uuid() })).query(({ input }) => scoreVaspTravelRuleRoute(input.dossierId, input.counterpartyId)),
    vaspReadinessIndex: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => computeVaspReadinessIndex(input.dossierId)),
    vaspOffshoreExposureConcentration: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => evaluateVaspOffshoreExposureConcentration(input.dossierId)),
    vaspIncidentPatterns: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => detectVaspIncidentPatterns(input.dossierId)),
    vaspRegulatoryCriticalPath: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => planVaspRegulatoryCriticalPath(input.dossierId)),
    vaspEvidenceIntegrityAudit: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => auditVaspEvidenceIntegrity(input.dossierId)),
    vaspSodConflictScan: auditorProcedure.query(() => scanVaspSodConflicts()),
    vaspAssurancePack: auditorProcedure.input(z.object({ dossierId: z.string().uuid() })).query(({ input }) => generateVaspAssurancePack(input.dossierId)),
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
    operatorAccessRequests: adminProcedure.query(() => listOperatorAccessRequests()),
    operators: adminProcedure.query(() => listOperators()),
    changeOperatorRole: adminProcedure.input(z.object({ subject: z.string().trim().min(3).max(255), role: z.enum(["admin", "compliance_officer", "treasury_operator", "auditor"]) })).mutation(({ ctx, input }) => changeOperatorRole({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    deactivateOperator: adminProcedure.input(z.object({ keycloakUserId: z.string().trim().min(1).max(255), subject: z.string().trim().min(3).max(255), reason: z.string().trim().min(10).max(2000) })).mutation(({ ctx, input }) => deactivateOperator({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    operatorOnboardingRecords: adminProcedure.query(() => listOperatorOnboardingRecords()),
    startOperatorOnboarding: adminProcedure.input(z.object({ subject: z.string().trim().min(3).max(255) })).mutation(({ ctx, input }) => startOperatorOnboarding({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordSodMatrixReview: adminProcedure.input(z.object({ onboardingId: z.string().uuid(), note: z.string().trim().min(10).max(2000) })).mutation(({ ctx, input }) => recordSodMatrixReview({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordLmsEnrolment: complianceProcedure.input(z.object({ onboardingId: z.string().uuid(), certReference: z.string().trim().min(1).max(255) })).mutation(({ ctx, input }) => recordLmsEnrolment({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordShadowPeriodSupervision: adminProcedure.input(z.object({ onboardingId: z.string().uuid(), supervisedBy: z.string().trim().min(1).max(255) })).mutation(({ ctx, input }) => recordShadowPeriodSupervision({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordOperatorRecertification: complianceProcedure.input(z.object({ onboardingId: z.string().uuid(), nextRecertDueAt: z.coerce.date() })).mutation(({ ctx, input }) => recordOperatorRecertification({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    auditorEngagements: adminProcedure.query(() => listAuditorEngagements()),
    startAuditorEngagement: adminProcedure.input(z.object({ auditorFirmName: z.string().trim().min(2).max(255), engagementReference: z.string().trim().min(2).max(255) })).mutation(({ ctx, input }) => startAuditorEngagement({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordEngagementLetter: adminProcedure.input(z.object({ engagementId: z.string().uuid(), engagementLetterUri: z.string().url(), scopeNote: z.string().trim().min(10).max(2000) })).mutation(({ ctx, input }) => recordEngagementLetter({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordAccessProvisioning: adminProcedure.input(z.object({ engagementId: z.string().uuid(), auditorSubject: z.string().trim().min(3).max(255) })).mutation(({ ctx, input }) => recordAccessProvisioning({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordAuditFieldwork: adminProcedure.input(z.object({ engagementId: z.string().uuid(), fieldworkNote: z.string().trim().min(10).max(2000) })).mutation(({ ctx, input }) => recordAuditFieldwork({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordAnnualReview: adminProcedure.input(z.object({ engagementId: z.string().uuid(), nextAnnualReviewDueAt: z.coerce.date() })).mutation(({ ctx, input }) => recordAnnualReview({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    grantOperatingRole: adminProcedure.input(z.object({ subject: z.string().trim().min(3).max(255), role: z.enum(["admin", "compliance_officer", "treasury_operator", "auditor"]) })).mutation(({ ctx, input }) => grantOperatingRole({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    operatorAccountCreationAvailable: adminProcedure.query(() => operatorAccountCreationAvailable()),
    onboardOperator: adminProcedure.input(z.object({ name: z.string().trim().min(2).max(120), email: z.string().trim().email().max(320), role: z.enum(["admin", "compliance_officer", "treasury_operator", "auditor", "provider_contact", "cbn_liaison"]), counterpartyId: z.string().uuid().optional(), dossierId: z.string().uuid().optional() }).superRefine((input, context) => { if ((input.role === "provider_contact") !== Boolean(input.counterpartyId) || (input.role === "cbn_liaison") !== Boolean(input.dossierId)) context.addIssue({ code: "custom", message: "assignment subject must match the stakeholder role" }); })).mutation(({ ctx, input }) => onboardOperator({ openId: ctx.user.openId, role: ctx.user.role }, input)),
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
    customerWorkspace: auditorProcedure.input(z.object({ customerId: z.string().uuid() })).query(async ({ input }) => {
      const workspace = await getCustomerWorkspace(input.customerId);
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "customer record was not found" });
      return workspace;
    }),
    beneficiaries: auditorProcedure.input(z.object({ customerId: z.string().uuid().optional() }).optional()).query(({ input }) => listPostgresBeneficiaries(input?.customerId)),
    createCustomer: complianceProcedure.input(z.object({ legalName: z.string().trim().min(2).max(255), registrationIdentifier: z.string().trim().min(2).max(255) })).mutation(({ ctx, input }) => createPostgresCustomer({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    updateCustomerProfile: complianceProcedure.input(z.object({ customerId: z.string().uuid(), archetype: z.enum(["importer", "exporter", "intercompany_rebalancing", "payroll_operator"]).optional(), tier: z.enum(["smb", "mid", "enterprise"]).optional(), country: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]).optional(), useCaseNarrative: z.string().trim().min(20).max(4000).optional() })).mutation(({ ctx, input }) => updatePostgresCustomerProfile({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordCustomerDestinationCounterparty: complianceProcedure.input(z.object({ customerId: z.string().uuid(), counterpartyName: z.string().trim().min(2).max(255), destinationJurisdiction: z.string().trim().min(2).max(120), invoiceReference: z.string().trim().min(1).max(2000).optional() })).mutation(({ ctx, input }) => recordCustomerDestinationCounterparty({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    decideCustomerUseCaseGate: complianceProcedure.input(z.object({ customerId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideCustomerUseCaseGate({ openId: ctx.user.openId, role: ctx.user.role }, input)),
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
    createKycDocumentUploadIntent: complianceProcedure.input(z.object({ customerId: z.string().uuid(), documentType: z.enum(["registration_certificate", "identity_document", "proof_of_address", "beneficial_ownership", "source_of_funds", "other", "ng_nin_reference", "ng_cac_registration", "ng_tax_identifier", "ng_director_identity", "ke_national_id_or_passport", "ke_business_registration_or_cr12", "ke_kra_pin", "ke_beneficial_ownership", "za_cipc_registration", "za_sars_tax_reference", "za_director_identity"]), originalFilename: z.string().trim().min(1).max(255), mimeType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff"]), sizeBytes: z.number().int().positive().max(26_214_400), contentSha256: z.string().regex(/^[a-f0-9]{64}$/) })).mutation(({ ctx, input }) => createPostgresKycDocumentUploadIntent({ openId: ctx.user.openId, role: ctx.user.role }, input)),
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
      counterpartyType: z.enum(["licensed_psp", "correspondent_bank", "stablecoin_provider", "fx_liquidity_provider", "custody_provider", "kyc_provider", "sanctions_provider", "chain_analytics_provider", "notification_provider", "regulatory_submission_provider", "travel_rule_provider", "adverse_media_provider"]),
      jurisdiction: z.string().trim().min(2).max(64),
    })).mutation(({ ctx, input }) => createPostgresCounterparty({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    liquidityProviders: auditorProcedure.query(() => listLiquidityProviders()),
    liquidityProviderWorkspace: auditorProcedure.input(z.object({ counterpartyId: z.string().uuid() })).query(async ({ input }) => {
      const workspace = await getLiquidityProviderWorkspace(input.counterpartyId);
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "counterparty record was not found" });
      return workspace;
    }),
    updateCounterpartyLpArchetype: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), archetype: z.enum(["principal_market_maker", "regional_liquidity_desk", "stablecoin_fiat_conversion_desk", "otc_counterparty"]) })).mutation(({ ctx, input }) => updateCounterpartyLpArchetype({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordCounterpartyEvidenceItem: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), evidenceType: z.enum(["mm_otc_licence", "incountry_vasp_licence", "beneficial_ownership_disclosure", "sanctions_pep_attestation", "audited_financials", "aml_cft_policy", "travel_rule_policy", "mlro_appointment_letter", "market_microstructure_policy", "reference_list", "insurance_certificate", "regulatory_disciplinary_history"]), evidenceUri: z.string().url(), note: z.string().trim().min(1).max(2000).optional() })).mutation(({ ctx, input }) => recordCounterpartyEvidenceItem({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    decideFinancialSoundnessGate: treasuryProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideFinancialSoundnessGate({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    bankingPartners: auditorProcedure.query(() => listBankingPartners()),
    bankingPartnerWorkspace: auditorProcedure.input(z.object({ counterpartyId: z.string().uuid() })).query(async ({ input }) => {
      const workspace = await getBankingPartnerWorkspace(input.counterpartyId);
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "counterparty record was not found" });
      return workspace;
    }),
    updateCounterpartyBankArchetype: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), archetype: z.enum(["correspondent_bank", "receiving_bank", "settlement_bank", "custodian_bank", "issuing_bank"]) })).mutation(({ ctx, input }) => updateCounterpartyBankArchetype({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordBankEvidenceItem: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), evidenceType: z.enum(["banking_licence", "aml_cft_attestation", "correspondent_agreement_template", "nostro_account_confirmation", "sanctions_policy", "travel_rule_readiness_attestation", "swift_message_support_confirmation", "fee_schedule", "audit_reports", "regulator_no_objection_letter", "cyber_bcm_evidence", "settlement_cutoff_calendar"]), evidenceUri: z.string().url(), note: z.string().trim().min(1).max(2000).optional() })).mutation(({ ctx, input }) => recordBankEvidenceItem({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    decideCryptoPostureGate: complianceProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideCryptoPostureGate({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    payoutPsps: auditorProcedure.query(() => listPayoutPsps()),
    payoutPspWorkspace: auditorProcedure.input(z.object({ counterpartyId: z.string().uuid() })).query(async ({ input }) => {
      const workspace = await getPayoutPspWorkspace(input.counterpartyId);
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "counterparty record was not found" });
      return workspace;
    }),
    updateCounterpartyPspArchetype: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), archetype: z.enum(["bank_instant_rail", "mobile_money", "virtual_card_issuer", "otc_cash_pickup", "aggregator_psp"]) })).mutation(({ ctx, input }) => updateCounterpartyPspArchetype({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordPspEvidenceItem: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), evidenceType: z.enum(["psp_licence", "mobile_money_authorisation", "aggregator_licence", "sanctions_pep_attestation", "aml_cft_policy", "beneficial_ownership_disclosure", "cutoff_settlement_calendar", "fee_schedule_fx_margin", "reconciliation_file_format_spec", "dispute_recall_channel_sla", "audited_financials", "cyber_bcp_attestation"]), evidenceUri: z.string().url(), note: z.string().trim().min(1).max(2000).optional() })).mutation(({ ctx, input }) => recordPspEvidenceItem({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    decidePspLicenceRailGate: complianceProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decidePspGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "licence_rail_coverage" })),
    decidePspSettlementCutoffGate: treasuryProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decidePspGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "settlement_cutoff_validation" })),
    decidePspBoundedLiveGate: complianceProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decidePspGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "bounded_live" })),
    decidePspFailoverGate: adminProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decidePspGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "failover_rail" })),
    stablecoinIssuers: auditorProcedure.query(() => listStablecoinIssuers()),
    stablecoinIssuerWorkspace: auditorProcedure.input(z.object({ counterpartyId: z.string().uuid() })).query(async ({ input }) => {
      const workspace = await getStablecoinIssuerWorkspace(input.counterpartyId);
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "counterparty record was not found" });
      return workspace;
    }),
    updateCounterpartyStablecoinIssuerArchetype: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), archetype: z.enum(["regulated_issuer", "open_issuer", "network"]) })).mutation(({ ctx, input }) => updateCounterpartyStablecoinIssuerArchetype({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordStablecoinIssuerEvidenceItem: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), evidenceType: z.enum(["issuer_regulatory_licence", "reserve_attestation", "reserve_asset_composition", "aml_cft_policy", "sanctions_ofac_attestation", "blockchain_finality_posture", "custody_provider_licence_insurance", "network_fee_schedule", "principal_beneficial_ownership_kyb", "audited_financials", "smart_contract_audit"]), evidenceUri: z.string().url(), note: z.string().trim().min(1).max(2000).optional() })).mutation(({ ctx, input }) => recordStablecoinIssuerEvidenceItem({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    decideStablecoinIssuerLicenceReservePostureGate: complianceOrTreasuryProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideStablecoinIssuerGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "licence_reserve_posture" })),
    decideStablecoinIssuerMintRedeemGate: treasuryProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideStablecoinIssuerGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "mint_redeem_technical_proof" })),
    decideStablecoinIssuerChainReadinessGate: adminProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideStablecoinIssuerGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "chain_readiness" })),
    decideStablecoinIssuerOperatingPostureGate: complianceOrTreasuryProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideStablecoinIssuerGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "operating_posture" })),
    complianceVendors: auditorProcedure.query(() => listComplianceVendors()),
    complianceVendorWorkspace: auditorProcedure.input(z.object({ counterpartyId: z.string().uuid() })).query(async ({ input }) => {
      const workspace = await getComplianceVendorWorkspace(input.counterpartyId);
      if (!workspace) throw new TRPCError({ code: "NOT_FOUND", message: "counterparty record was not found" });
      return workspace;
    }),
    updateCounterpartyComplianceVendorArchetype: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), archetype: z.enum(["kyc_kyb_platform", "sanctions_screening", "chain_analytics", "travel_rule_vendor", "adverse_media"]) })).mutation(({ ctx, input }) => updateCounterpartyComplianceVendorArchetype({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordComplianceVendorEvidenceItem: complianceProcedure.input(z.object({ counterpartyId: z.string().uuid(), evidenceType: z.enum(["soc2_or_iso27001_report", "information_security_policy", "privacy_policy_dpa_template", "penetration_test_summary", "insurance_certificate", "beneficial_ownership_disclosure", "vendor_sanctions_compliance_posture", "list_data_sourcing_summary", "sub_processor_list", "sla_template_uptime_commitment"]), evidenceUri: z.string().url(), note: z.string().trim().min(1).max(2000).optional() })).mutation(({ ctx, input }) => recordComplianceVendorEvidenceItem({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    decideComplianceVendorSecurityPostureGate: complianceProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideComplianceVendorGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "security_posture" })),
    decideComplianceVendorCoverageFeasibilityGate: complianceProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideComplianceVendorGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "coverage_feasibility" })),
    decideComplianceVendorFalsePositiveCeilingGate: complianceProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideComplianceVendorGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "false_positive_ceiling" })),
    decideComplianceVendorAnnualReviewGate: complianceProcedure.input(z.object({ onboardingId: z.string().uuid(), decision: z.enum(["approved", "blocked"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => decideComplianceVendorGate({ openId: ctx.user.openId, role: ctx.user.role }, { ...input, gate: "annual_review" })),
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
  stakeholder: router({
    requestAccount: publicProcedure.input(z.object({
      username: z.string().regex(/^[a-z][a-z0-9_.-]{2,63}$/),
      displayName: z.string().trim().min(2).max(120),
      password: z.string().min(12),
      requestedRole: z.enum(["compliance_officer", "treasury_operator", "auditor", "admin"]),
      notificationEmail: z.string().email().optional(),
    })).mutation(({ input }) => requestStakeholderAccount(input)),
    accounts: auditorProcedure.input(z.object({ status: z.enum(["pending_approval", "active", "suspended"]).optional() }).optional()).query(({ input }) => listStakeholderAccounts(input?.status)),
    decideAdministratorApproval: adminProcedure.input(z.object({
      administratorAccountId: uuid,
      decision: z.enum(["approved", "rejected", "suspended", "revoked"]),
      rationale,
    })).mutation(({ ctx, input }) => decideAdministratorApproval({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    transitionAccount: adminProcedure.input(z.object({
      accountId: uuid, target: z.enum(["active", "suspended"]), reason: z.string().trim().min(8).max(4000),
    })).mutation(({ ctx, input }) => transitionStakeholderAccount({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    assignSuperAdministrator: adminProcedure.input(z.object({ subject: z.string().min(3).max(256) }))
      .mutation(({ ctx, input }) => assignSuperAdministrator({ openId: ctx.user.openId, role: ctx.user.role }, input.subject)),
    revokeSuperAdministrator: adminProcedure.input(z.object({ subject: z.string().min(3).max(256), reason: z.string().trim().min(16).max(4000) }))
      .mutation(({ ctx, input }) => revokeSuperAdministrator({ openId: ctx.user.openId, role: ctx.user.role }, input.subject, input.reason)),
    superAdministrators: auditorProcedure.query(() => listSuperAdministrators()),
    governanceAudit: auditorProcedure.input(z.object({ accountId: uuid.optional() }).optional()).query(({ input }) => listAdministratorGovernanceAudit(input?.accountId)),
    sessions: auditorProcedure.input(z.object({ accountId: uuid.optional() }).optional()).query(({ input }) => listStakeholderSessions(input?.accountId)),
    revokeSession: adminProcedure.input(z.object({ sessionId: uuid, reason: z.string().trim().min(8) }))
      .mutation(({ ctx, input }) => revokeStakeholderSession({ openId: ctx.user.openId, role: ctx.user.role }, input.sessionId, input.reason)),
    notificationPreferences: auditorProcedure.input(z.object({ accountId: uuid })).query(({ input }) => getNotificationPreferences(input.accountId)),
    updateNotificationPreferences: adminProcedure.input(z.object({ accountId: uuid, emailKycRemindersEnabled: z.boolean() }))
      .mutation(({ ctx, input }) => upsertNotificationPreferences({ openId: ctx.user.openId, role: ctx.user.role }, input.accountId, input.emailKycRemindersEnabled)),
    securityMessages: auditorProcedure.input(z.object({ accountId: uuid })).query(({ input }) => listSecurityMessages(input.accountId)),
    kycReminderDeliveries: auditorProcedure.input(z.object({ accountId: uuid.optional() }).optional()).query(({ input }) => listKycReminderDeliveries(input?.accountId)),
  }),
  administratorKyc: router({
    workspace: complianceProcedure.input(z.object({ accountId: uuid })).query(({ input }) => getAdministratorKycWorkspace(input.accountId)),
    uploadPolicy: auditorProcedure.query(() => getAdministratorKycUploadPolicy()),
    updateUploadPolicy: adminProcedure.input(z.object({ maxFileBytes: z.number().int().min(1048576).max(52428800), reason: z.string().trim().min(16).max(2000) }))
      .mutation(({ ctx, input }) => updateAdministratorKycUploadPolicy({ openId: ctx.user.openId, role: ctx.user.role }, input.maxFileBytes, input.reason)),
    uploadPolicyAudit: auditorProcedure.query(() => listAdministratorKycUploadPolicyAudit()),
    createUploadIntent: complianceProcedure.input(z.object({
      administratorAccountId: uuid, evidenceKind: z.enum(ADMIN_KYC_EVIDENCE_KINDS),
      jurisdictionCode: z.enum(ADMIN_KYC_JURISDICTIONS), originalFilename: z.string().min(1).max(180),
      mimeType: z.enum(["application/pdf", "image/jpeg", "image/png"]),
      sizeBytes: z.number().int().positive(), contentSha256: sha256Hex, storageKey: z.string().min(8),
      ttlMinutes: z.number().int().min(5).max(1440).optional(),
    })).mutation(({ ctx, input }) => createAdministratorKycUploadIntent({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    finalizeUploadIntent: complianceProcedure.input(z.object({ intentId: uuid }))
      .mutation(({ ctx, input }) => finalizeAdministratorKycUploadIntent({ openId: ctx.user.openId, role: ctx.user.role }, input.intentId)),
    recordOversizeException: complianceOnlyProcedure.input(z.object({
      uploadIntentId: uuid, administratorAccountId: uuid, jurisdictionCode: z.enum(ADMIN_KYC_JURISDICTIONS),
      exceptionRationale: z.string().trim().min(16).max(4000),
    })).mutation(({ ctx, input }) => recordAdministratorKycOversizeException({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    submitEvidence: complianceProcedure.input(z.object({
      administratorAccountId: uuid, evidenceKind: z.enum(ADMIN_KYC_EVIDENCE_KINDS),
      jurisdictionCode: z.enum(ADMIN_KYC_JURISDICTIONS), referenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => submitAdministratorKycEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordReview: complianceOnlyProcedure.input(z.object({
      administratorAccountId: uuid, outcome: z.enum(["approved", "rejected", "needs_information"]), rationale,
    })).mutation(({ ctx, input }) => recordAdministratorKycReview({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createEvidenceRequest: complianceOnlyProcedure.input(z.object({
      administratorAccountId: uuid, requestSummary: z.string().trim().min(8).max(2000), dueAt: z.coerce.date().optional(),
    })).mutation(({ ctx, input }) => createAdministratorKycEvidenceRequest({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    transitionEvidenceRequest: complianceProcedure.input(z.object({
      requestId: uuid, target: z.enum(["submitted", "resolved", "closed"]),
    })).mutation(({ ctx, input }) => transitionAdministratorKycEvidenceRequest({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    raiseEscalation: complianceOnlyProcedure.input(z.object({
      administratorAccountId: uuid,
      reason: z.enum(["sanctions_pep_concern", "liveness_deepfake_concern", "evidence_mismatch", "single_evidence_exception", "compliance_discretion"]),
    })).mutation(({ ctx, input }) => raiseAdministratorKycEscalation({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordReviewEntry: complianceOnlyProcedure.input(z.object({
      administratorAccountId: uuid, escalationId: uuid.nullable().optional(), reviewSequence: z.union([z.literal(1), z.literal(2)]),
      outcome: z.enum(["approved", "rejected", "needs_information"]), rationale,
    })).mutation(({ ctx, input }) => recordAdministratorKycReviewEntry({ openId: ctx.user.openId, role: ctx.user.role }, input)),
  }),
  tradeControl: router({
    cases: auditorProcedure.input(z.object({ legalEntityId: uuid.optional() }).optional()).query(({ input }) => listTradeCases(input?.legalEntityId)),
    workspace: auditorProcedure.input(z.object({ tradeCaseId: uuid })).query(({ input }) => getTradeCaseWorkspace(input.tradeCaseId)),
    createCase: complianceOrTreasuryProcedure.input(z.object({
      caseReference: z.string().regex(/^TPC-[A-Z0-9][A-Z0-9-]{5,78}$/),
      legalEntityId: uuid, customerId: uuid.nullable().optional(), supplierBeneficiaryId: uuid.nullable().optional(),
      corridor: z.string().min(2), purchaseCurrency: z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]),
      purchaseAmount: z.string().regex(/^\d+(\.\d{1,12})?$/), intendedSettlementCurrency: z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]),
      purposeSummary: z.string().trim().min(16).max(4000),
    })).mutation(({ ctx, input }) => createTradeCase({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    transitionCase: complianceOrTreasuryProcedure.input(z.object({ tradeCaseId: uuid, targetStatus: z.string().min(2) }))
      .mutation(({ ctx, input }) => transitionTradeCase({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    assignStakeholder: complianceOrTreasuryProcedure.input(z.object({
      tradeCaseId: uuid, stakeholderRole: z.enum(TRADE_STAKEHOLDER_ROLES), stakeholderSubject: z.string().min(3),
    })).mutation(({ ctx, input }) => assignTradeCaseStakeholder({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    revokeStakeholder: complianceOrTreasuryProcedure.input(z.object({ stakeholderId: uuid }))
      .mutation(({ ctx, input }) => revokeTradeCaseStakeholder({ openId: ctx.user.openId, role: ctx.user.role }, input.stakeholderId)),
    submitEvidence: complianceOrTreasuryProcedure.input(z.object({
      tradeCaseId: uuid, evidenceKind: z.enum(TRADE_EVIDENCE_KINDS), evidenceUri: httpsUri, evidenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => submitTradeCaseEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    reviewEvidence: complianceOnlyProcedure.input(z.object({
      evidenceId: uuid, decision: z.enum(["accepted", "rejected", "replacement_requested"]), rationale: z.string().trim().min(16).max(4000).optional(),
    })).mutation(({ ctx, input }) => reviewTradeCaseEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    configureRoute: complianceOrTreasuryProcedure.input(z.object({
      tradeCaseId: uuid, counterpartyId: uuid, integrationConnectionId: uuid,
      routeKind: z.enum(["authorised_dealer_fx", "bank_supplier_settlement", "stablecoin_conversion", "supply_chain_finance"]),
      sourceCurrency: z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]), targetCurrency: z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]),
      routePolicyEvidenceUri: httpsUri, routePolicyEvidenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => configureTradeCaseRoute({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    transitionRoute: complianceOnlyProcedure.input(z.object({
      routeId: uuid, readinessState: z.enum(["evidence_pending", "pending_compliance_review", "approved_for_authorised_release", "blocked"]),
    })).mutation(({ ctx, input }) => transitionTradeCaseRoute({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordApproval: complianceOrTreasuryProcedure.input(z.object({
      tradeCaseId: uuid, approvalRole: z.enum(TRADE_APPROVAL_ROLES),
      decision: z.enum(["approved", "blocked", "needs_information"]), rationale,
    })).mutation(({ ctx, input }) => recordTradeCaseApproval({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    raiseException: complianceOrTreasuryProcedure.input(z.object({
      tradeCaseId: uuid,
      exceptionKind: z.enum(["documentary_gap", "counterparty_scope", "route_capacity", "beneficiary_change", "travel_rule_gap", "stablecoin_provenance_gap", "policy_conflict", "other"]),
      rationale,
    })).mutation(({ ctx, input }) => raiseTradeCaseException({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    resolveException: complianceOnlyProcedure.input(z.object({
      exceptionId: uuid, decision: z.enum(["remediated", "rejected"]), resolutionRationale: rationale,
    })).mutation(({ ctx, input }) => resolveTradeCaseException({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordReconciliation: complianceProcedure.input(z.object({
      tradeCaseId: uuid,
      referenceKind: z.enum(["provider_confirmation", "bank_reference", "supplier_receipt", "trade_finance_reference", "stablecoin_attestation"]),
      referenceUri: httpsUri, referenceSha256: sha256Hex, status: z.enum(["recorded", "consistent", "discrepant"]),
    })).mutation(({ ctx, input }) => recordTradeCaseReconciliation({ openId: ctx.user.openId, role: ctx.user.role }, input)),
  }),
  enterpriseGovernance: router({
    workspace: auditorProcedure.input(z.object({ legalEntityId: uuid })).query(({ input }) => getEnterpriseGovernanceWorkspace(input.legalEntityId)),
    registerGovernedBankAccount: treasuryProcedure.input(z.object({
      legalEntityId: uuid, counterpartyId: uuid, integrationConnectionId: uuid,
      countryCode: z.string().length(2), currency: z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]),
      accountReferenceHash: sha256Hex, mandateEvidenceUri: httpsUri, mandateEvidenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => registerGovernedBankAccount({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordLiquidityPolicy: treasuryProcedure.input(z.object({
      legalEntityId: uuid, countryCode: z.string().length(2), currency: z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]),
      concentrationLimitPercent: z.number().min(0).max(100), approvalThresholdAmount: z.string().regex(/^\d+(\.\d{1,12})?$/),
      policyEvidenceUri: httpsUri, policyEvidenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => recordLiquidityGovernancePolicy({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordStablecoinMandate: treasuryProcedure.input(z.object({
      legalEntityId: uuid, asset: z.enum(["USDC", "USDT"]), counterpartyId: uuid, integrationConnectionId: uuid,
      maximumExposure: z.string().regex(/^\d+(\.\d{1,12})?$/), requiresTravelRule: z.boolean(), requiresBeneficiaryEvidence: z.boolean(),
      mandateEvidenceUri: httpsUri, mandateEvidenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => recordStablecoinTreasuryMandate({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    registerSupplyChainProgramme: treasuryProcedure.input(z.object({
      legalEntityId: uuid, funderCounterpartyId: uuid, integrationConnectionId: uuid, supplierBeneficiaryId: uuid,
      programmeReference: z.string().min(4), receivableEvidenceUri: httpsUri, receivableEvidenceSha256: sha256Hex,
      programmePolicyUri: httpsUri, programmePolicySha256: sha256Hex,
    })).mutation(({ ctx, input }) => registerSupplyChainFinanceProgramme({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    registerSpendCardProgramme: treasuryProcedure.input(z.object({
      legalEntityId: uuid, counterpartyId: uuid, integrationConnectionId: uuid, programmeReference: z.string().min(4),
      countryCode: z.string().length(2), currency: z.enum(["NGN", "KES", "ZAR", "USD"]),
      programmeEvidenceUri: httpsUri, programmeEvidenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => registerSpendCardProgramme({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordSpendPolicyRule: treasuryProcedure.input(z.object({
      spendCardProgrammeId: uuid,
      ruleKind: z.enum(["category", "per_transaction_limit", "period_limit", "employee_eligibility", "receipt_requirement"]),
      ruleValue: z.record(z.unknown()), evidenceUri: httpsUri, evidenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => recordSpendPolicyRule({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    spendPolicyRules: auditorProcedure.input(z.object({ spendCardProgrammeId: uuid })).query(({ input }) => listSpendPolicyRules(input.spendCardProgrammeId)),
    recordReview: complianceProcedure.input(z.object({
      moduleKind: z.enum(["multi_bank_treasury", "stablecoin_treasury", "supply_chain_finance", "spend_card_programme"]),
      subjectId: uuid, decision: z.enum(["approved", "blocked", "needs_information"]), rationale,
    })).mutation(({ ctx, input }) => recordEnterpriseGovernanceReview({ openId: ctx.user.openId, role: ctx.user.role }, input)),
  }),
  controlAssurance: router({
    recordAssessment: assuranceVerifierProcedure.input(z.object({
      assessmentKind: z.enum(ASSURANCE_KINDS), subjectType: z.string().min(2), subjectId: z.string().min(2),
      outcome: z.enum(["covered", "attention_required", "blocked", "unavailable"]),
      findingCodes: z.array(z.string()), evidenceUri: httpsUri, evidenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => recordControlAssuranceAssessment({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordAdapterCertification: complianceProcedure.input(z.object({
      counterpartyId: uuid, integrationConnectionId: uuid.nullable().optional(), adapterKind: z.enum(ADAPTER_KINDS),
      certificationState: z.enum(["documented", "evidence_pending", "ready_for_controlled_test", "blocked", "retired"]),
      corridor: z.string().nullable().optional(), asset: z.enum(["USDC", "USDT", "NGN", "KES", "ZAR", "USD"]).nullable().optional(),
      evidenceUri: httpsUri, evidenceSha256: sha256Hex, controlledTestReference: z.string().nullable().optional(),
    })).mutation(({ ctx, input }) => recordAdapterCertificationEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordAuditPacket: assuranceVerifierProcedure.input(z.object({
      packetScope: z.enum(PACKET_SCOPES), scopeReference: z.string().min(2),
      packetUri: httpsUri, packetSha256: sha256Hex, evidenceCount: z.number().int().min(0),
    })).mutation(({ ctx, input }) => recordControlAuditPacket({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    assessments: auditorProcedure.input(z.object({ subjectType: z.string().optional(), subjectId: z.string().optional() }).optional())
      .query(({ input }) => listControlAssuranceAssessments(input?.subjectType, input?.subjectId)),
    adapterCertifications: auditorProcedure.input(z.object({ counterpartyId: uuid.optional() }).optional())
      .query(({ input }) => listAdapterCertificationEvidence(input?.counterpartyId)),
    auditPackets: auditorProcedure.input(z.object({ packetScope: z.string().optional(), scopeReference: z.string().optional() }).optional())
      .query(({ input }) => listControlAuditPackets(input?.packetScope, input?.scopeReference)),
  }),
  executionRehearsal: router({
    configureStablecoinRoute: treasuryProcedure.input(z.object({
      corridor: z.string().min(2), asset: z.enum(["USDC", "USDT"]), counterpartyId: uuid, integrationConnectionId: uuid,
      requiresTravelRule: z.boolean(), beneficiaryEvidenceRequired: z.boolean(),
      routePolicyEvidenceUri: httpsUri, routePolicyEvidenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => configureStablecoinOrchestrationRoute({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    reviewStablecoinRoute: complianceProcedure.input(z.object({ routeId: uuid, decision: z.enum(["approved", "blocked"]), rationale }))
      .mutation(({ ctx, input }) => reviewStablecoinOrchestrationRoute({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    stablecoinRoutes: auditorProcedure.input(z.object({ corridor: z.string().optional() }).optional()).query(({ input }) => listStablecoinOrchestrationRoutes(input?.corridor)),
    recordAuthorisedTest: complianceProcedure.input(z.object({
      counterpartyId: uuid, corridor: z.string().min(2), testPlanEvidenceUri: httpsUri,
      authorisationEvidenceUri: httpsUri.nullable().optional(), status: z.enum(["documented", "authorised", "blocked", "closed"]),
    })).mutation(({ ctx, input }) => recordAuthorisedExecutionTest({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordRehearsal: complianceProcedure.input(z.object({
      paymentOrderId: uuid, counterpartyId: uuid, stablecoinRouteId: uuid.nullable().optional(),
      outcome: z.enum(["blocked", "ready_for_authorised_execution"]),
      prerequisiteSnapshot: z.record(z.unknown()), rationale,
    })).mutation(({ ctx, input }) => recordExecutionApprovalRehearsal({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    rehearsals: auditorProcedure.input(z.object({ paymentOrderId: uuid.optional() }).optional()).query(({ input }) => listExecutionApprovalRehearsals(input?.paymentOrderId)),
    recordExecutionEvidence: complianceProcedure.input(z.object({
      paymentOrderId: uuid, routeId: uuid, evidenceKind: z.enum(["travel_rule", "beneficiary_verification", "wallet_ownership"]),
      evidenceUri: httpsUri, evidenceSha256: sha256Hex,
    })).mutation(({ ctx, input }) => recordStablecoinExecutionEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    executionEvidence: auditorProcedure.input(z.object({ paymentOrderId: uuid })).query(({ input }) => listStablecoinExecutionEvidence(input.paymentOrderId)),
    recordSettlementAttempt: treasuryProcedure.input(z.object({
      paymentOrderId: uuid, paymentLegId: uuid, idempotencyKey: z.string().min(8), payloadSha256: sha256Hex,
      direction: z.enum(["onramp", "offramp"]), asset: z.enum(["USDC", "USDT"]),
      fiatCurrency: z.enum(["NGN", "KES", "ZAR", "USD"]), amountMinor: z.string().regex(/^\d+$/),
      providerReference: z.string().nullable().optional(),
    })).mutation(({ ctx, input }) => recordStablecoinSettlementAttempt({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    settlementAttempts: auditorProcedure.input(z.object({ paymentOrderId: uuid.optional() }).optional()).query(({ input }) => listStablecoinSettlementAttempts(input?.paymentOrderId)),
  }),
  ledgerReconciliation: router({
    recordPostingIntent: treasuryProcedure.input(z.object({
      postingIdentity: z.string().min(8), correlationId: z.string().min(8),
      currency: z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]), amountMinor: z.string().regex(/^\d+$/),
      debitAccountId: z.number().int().positive(), creditAccountId: z.number().int().positive(),
      expectedTransferId: z.number().int().positive().nullable().optional(),
    })).mutation(({ ctx, input }) => recordLedgerPostingIntent({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    transitionPostingIntent: treasuryProcedure.input(z.object({
      postingIdentity: z.string().min(8), intentState: z.enum(["posted", "voided", "blocked"]),
      expectedTransferId: z.number().int().positive().nullable().optional(),
    })).mutation(({ ctx, input }) => transitionLedgerPostingIntent({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordRun: assuranceVerifierProcedure.input(z.object({
      runReference: z.string().min(8), windowStart: z.coerce.date(), windowEnd: z.coerce.date(),
      status: z.enum(["reconciled", "discrepancy", "indeterminate"]),
      intentCount: z.number().int().min(0), factCount: z.number().int().min(0), discrepancyCount: z.number().int().min(0),
      sourceIdentity: z.string().min(2), errorSummary: z.string().nullable().optional(),
    })).mutation(({ ctx, input }) => recordLedgerReconciliationRun({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    recordDiscrepancy: assuranceVerifierProcedure.input(z.object({
      runId: uuid, postingIdentity: z.string().nullable().optional(), tigerbeetleTransferId: z.number().int().positive().nullable().optional(),
      discrepancyCode: z.enum(["missing_fact", "unexpected_fact", "field_mismatch", "duplicate_identity", "invalid_balance"]),
      expected: z.record(z.unknown()).nullable().optional(), observed: z.record(z.unknown()).nullable().optional(),
    })).mutation(({ ctx, input }) => recordLedgerReconciliationDiscrepancy({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    postingIntents: auditorProcedure.input(z.object({ intentState: z.string().optional() }).optional()).query(({ input }) => listLedgerPostingIntents(input?.intentState)),
    runs: auditorProcedure.input(z.object({ status: z.string().optional() }).optional()).query(({ input }) => listLedgerReconciliationRuns(input?.status)),
    discrepancies: auditorProcedure.input(z.object({ runId: uuid })).query(({ input }) => listLedgerReconciliationDiscrepancies(input.runId)),
  }),
  livePipelines: router({
    recordProviderSend: complianceProcedure.input(z.object({
      paymentOrderId: uuid, paymentLegId: uuid, integrationConnectionId: uuid,
      providerReference: z.string().min(4), providerStatus: z.string().min(2), requestSha256: sha256Hex,
    })).mutation(({ ctx, input }) => recordProviderSendRequest({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    transitionProviderSend: complianceProcedure.input(z.object({
      sendRequestId: uuid, finalityState: z.enum(["webhook_confirmed", "reconciliation_pending", "reconciled", "failed", "discrepancy"]),
      providerFinalityReference: z.string().nullable().optional(), reconciliationReference: z.string().nullable().optional(),
    })).mutation(({ ctx, input }) => transitionProviderSendRequest({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    providerSends: auditorProcedure.input(z.object({ paymentOrderId: uuid.optional() }).optional()).query(({ input }) => listProviderSendRequests(input?.paymentOrderId)),
    recordRegulatorySubmission: complianceProcedure.input(z.object({
      regulatoryReportId: uuid, integrationConnectionId: uuid, channelReference: z.string().min(2), requestSha256: sha256Hex,
      attemptState: z.enum(["prepared", "submitted", "accepted", "rejected", "unavailable"]),
      externalReference: z.string().nullable().optional(), responseEvidenceSha256: sha256Hex.nullable().optional(),
    })).mutation(({ ctx, input }) => recordRegulatorySubmissionAttempt({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    regulatorySubmissions: auditorProcedure.input(z.object({ regulatoryReportId: uuid.optional() }).optional()).query(({ input }) => listRegulatorySubmissionAttempts(input?.regulatoryReportId)),
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
