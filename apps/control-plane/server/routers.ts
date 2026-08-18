import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, auditorProcedure, complianceProcedure, publicProcedure, router } from "./_core/trpc";
import { createPostgresCounterparty, createPostgresCounterpartyAuthorization, createPostgresDocumentAnalysisJob, createPostgresRegulatoryReportDraft, createPostgresReviewerDecision, createPostgresVerificationConsent, getPostgresCutoverReadiness, getPostgresReadiness, listPostgresCounterparties, listPostgresCounterpartyAuthorizations, listPostgresDocumentAnalysisJobs, listPostgresKycDocuments, listPostgresNotificationDeliveries, listPostgresRegulatoryDeadlines, listPostgresSarStrFilings, persistPostgresDocumentAnalysisEvidence } from "./postgres";
import { umojaFlowRouter } from "./routers/umojaflowos";
import { parseNonExecutableComplianceEvent } from "./contracts/events";
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
    counterpartyAuthorizations: auditorProcedure.query(() => listPostgresCounterpartyAuthorizations()),
    kycDocuments: auditorProcedure.query(() => listPostgresKycDocuments()),
    sarStrFilings: auditorProcedure.query(() => listPostgresSarStrFilings()),
    regulatoryDeadlines: auditorProcedure.query(() => listPostgresRegulatoryDeadlines()),
    notificationDeliveries: auditorProcedure.query(() => listPostgresNotificationDeliveries()),
    documentAnalysisJobs: auditorProcedure.query(() => listPostgresDocumentAnalysisJobs()),
    createVerificationConsent: complianceProcedure.input(z.object({ scope: z.enum(["kyc", "kyb"]), subjectReference: z.string().trim().min(3).max(255), consentVersion: z.string().trim().min(1).max(128), purpose: z.string().trim().min(10).max(1000), grantedAt: z.coerce.date(), expiresAt: z.coerce.date().optional() })).mutation(({ ctx, input }) => createPostgresVerificationConsent({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createDocumentAnalysisJob: complianceProcedure.input(z.object({ consentId: z.string().uuid(), kycDocumentId: z.string().uuid().optional(), caseKind: z.enum(["kyc", "kyb"]), documentClass: z.string().trim().min(3).max(128), sourceSha256: z.string().regex(/^[a-f0-9]{64}$/), sourceUri: z.string().url(), mimeType: z.enum(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/tiff"]) })).mutation(({ ctx, input }) => createPostgresDocumentAnalysisJob({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    persistDocumentAnalysisEvidence: complianceProcedure.input(z.object({ analysisJobId: z.string().uuid(), kind: z.enum(["ocr", "document_structure", "visual_consistency", "presentation_attack_risk", "engine_unavailable"]), disposition: z.enum(["review_required", "insufficient_evidence", "unavailable"]), engineName: z.string().trim().min(2).max(128), engineVersion: z.string().trim().min(1).max(128), modelTag: z.string().trim().max(128).optional(), modelDigest: z.string().trim().max(256).optional(), promptPolicyVersion: z.string().trim().max(128).optional(), evidenceSha256: z.string().regex(/^[a-f0-9]{64}$/).optional(), signals: z.array(z.unknown()).max(100), limitations: z.array(z.string().trim().min(1).max(1200)).min(1).max(50) })).mutation(({ ctx, input }) => persistPostgresDocumentAnalysisEvidence({ openId: ctx.user.openId, role: ctx.user.role }, input)),
    createReviewerDecision: complianceProcedure.input(z.object({ analysisJobId: z.string().uuid(), disposition: z.enum(["approved", "rejected", "needs_information", "escalated"]), rationale: z.string().trim().min(10).max(4000) })).mutation(({ ctx, input }) => createPostgresReviewerDecision({ openId: ctx.user.openId, role: ctx.user.role }, input)),
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
    createRegulatoryReportDraft: complianceProcedure.input(z.object({ regulator: z.enum(["CBN", "CBK", "SARB"]), corridor: z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]), reportType: z.string().trim().min(4).max(255), periodStart: z.coerce.date(), periodEnd: z.coerce.date(), legalEntityId: z.string().uuid() }).refine(input => input.periodEnd >= input.periodStart, { message: "period end must not precede period start" })).mutation(({ ctx, input }) => createPostgresRegulatoryReportDraft({ openId: ctx.user.openId, role: ctx.user.role }, input)),
  }),
	  contracts: router({
	    parseCompliancePolicyDecision: complianceProcedure.input(z.unknown()).mutation(({ input }) => parseNonExecutableComplianceEvent(input)),
	  }),
	  umoja: umojaFlowRouter,
});

export type AppRouter = typeof appRouter;
