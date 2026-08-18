import { z } from "zod";
import { parse as parseCookie } from "cookie";
import * as db from "../db";
import { adminProcedure, auditorProcedure, complianceProcedure, router, treasuryProcedure } from "../_core/trpc";
import { createHeartbeatJob } from "../_core/heartbeat";
import { COOKIE_NAME } from "@shared/const";
import { TRPCError } from "@trpc/server";

const corridor = z.enum(["NIGERIA_NGN", "KENYA_KES", "SOUTH_AFRICA_ZAR"]);
const currency = z.enum(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]);
const decimal = z.string().regex(/^\d+(\.\d{1,12})?$/, "Enter a non-negative decimal value with up to 12 decimal places");
const actorOf = (user: { openId: string; role: "admin" | "compliance_officer" | "treasury_operator" | "auditor" }) => ({ openId: user.openId, role: user.role });

export const umojaFlowRouter = router({
  overview: auditorProcedure.query(() => db.getDashboardSnapshot()),

  registry: router({
    list: auditorProcedure.query(() => db.listCounterparties()),
    listAuthorizations: auditorProcedure.query(() => db.listCounterpartyAuthorizations()),
    create: adminProcedure
      .input(z.object({
        legalName: z.string().trim().min(2).max(255),
        counterpartyType: z.enum(["licensed_psp", "correspondent_bank", "stablecoin_provider", "fx_liquidity_provider", "custody_provider", "kyc_provider", "sanctions_provider", "chain_analytics_provider", "notification_provider", "regulatory_submission_provider"]),
        jurisdiction: z.string().trim().min(2).max(64),
      }))
      .mutation(({ ctx, input }) => db.createCounterparty(actorOf(ctx.user), input)),
    createAuthorization: adminProcedure
      .input(z.object({
        counterpartyId: z.number().int().positive(),
        regulator: z.enum(["CBN", "CBK", "SARB", "SEC", "CMA", "FSCA", "FIC"]),
        licenceReference: z.string().trim().min(1).max(255),
        scopeDescription: z.string().trim().min(10),
        evidenceUrl: z.string().url(),
        validFrom: z.coerce.date(),
        validTo: z.coerce.date().optional(),
        status: z.enum(["pending_review", "verified", "expired", "suspended", "rejected"]).default("pending_review"),
      }))
      .mutation(({ ctx, input }) => db.createCounterpartyAuthorization(actorOf(ctx.user), input)),
    transitionAuthorization: adminProcedure
      .input(z.object({ authorizationId: z.number().int().positive(), status: z.enum(["pending_review", "verified", "expired", "suspended", "rejected"]) }))
      .mutation(({ ctx, input }) => db.transitionCounterpartyAuthorization(actorOf(ctx.user), input)),
  }),

  integrations: router({
    list: auditorProcedure.query(() => db.listIntegrations()),
    create: adminProcedure
      .input(z.object({
        counterpartyId: z.number().int().positive(),
        category: z.enum(["payment_rail", "fx_rate", "stablecoin_market_data", "kyc_kyb", "sanctions", "chain_analytics", "notification", "regulatory_submission"]),
        environment: z.enum(["sandbox", "production"]),
        documentationUrl: z.string().url(),
        secretReference: z.string().trim().min(1).max(255).optional(),
      }))
      .mutation(({ ctx, input }) => db.createIntegrationConnection(actorOf(ctx.user), input)),
  }),

  policies: router({
    list: auditorProcedure.query(() => db.listCorridorPolicies()),
    create: complianceProcedure
      .input(z.object({
        corridor,
        regulator: z.enum(["CBN", "CBK", "SARB"]),
        policyVersion: z.string().trim().min(1).max(128),
        effectiveFrom: z.coerce.date(),
        effectiveTo: z.coerce.date().optional(),
        requiresTravelRule: z.boolean().default(false),
        requiresAuthorizedFxIntermediary: z.boolean().default(true),
        activationStatus: z.enum(["pending_review", "verified", "expired", "suspended", "rejected"]).default("pending_review"),
        policyDocumentUrl: z.string().url(),
      }))
      .mutation(({ ctx, input }) => db.createCorridorPolicy(actorOf(ctx.user), input)),
  }),

  parties: router({
    listCustomers: auditorProcedure.query(() => db.listCustomers()),
    listBeneficiaries: auditorProcedure.input(z.object({ customerId: z.number().int().positive().optional() }).optional()).query(({ input }) => db.listBeneficiaries(input?.customerId)),
    createCustomer: complianceProcedure
      .input(z.object({ legalName: z.string().trim().min(2).max(255), registrationIdentifier: z.string().trim().min(2).max(255) }))
      .mutation(({ ctx, input }) => db.createCustomer(actorOf(ctx.user), input)),
    createBeneficiary: complianceProcedure
      .input(z.object({ customerId: z.number().int().positive(), legalName: z.string().trim().min(2).max(255), countryCode: z.string().trim().length(2).toUpperCase(), bankOrWalletReference: z.string().trim().min(4).max(512) }))
      .mutation(({ ctx, input }) => db.createBeneficiary(actorOf(ctx.user), input)),
  }),

  treasury: router({
    listLiquidity: auditorProcedure.query(() => db.listLiquidityPositions()),
    recordLiquidity: treasuryProcedure
      .input(z.object({ corridor, currency, accountKind: z.enum(["liquidity_pool", "nostro", "vostro", "prefunding", "custody_wallet"]), accountReference: z.string().trim().min(2).max(255), availableAmount: decimal, reservedAmount: decimal.default("0"), sourceReference: z.string().trim().min(4).max(512), reconciledAt: z.coerce.date() }))
      .mutation(({ ctx, input }) => db.recordLiquidityPosition(actorOf(ctx.user), input)),
  }),

  markets: router({
    list: auditorProcedure.query(() => db.listMarketObservations()),
    record: treasuryProcedure
      .input(z.object({ integrationConnectionId: z.number().int().positive(), baseAsset: currency, quoteAsset: currency, rate: decimal.refine(value => value !== "0", "Rate must be greater than zero"), observedAt: z.coerce.date(), sourceReference: z.string().url() }).refine(value => value.baseAsset !== value.quoteAsset, "The base and quote assets must differ"))
      .mutation(({ ctx, input }) => db.recordMarketObservation(actorOf(ctx.user), input)),
    listRateLocks: auditorProcedure.query(() => db.listRateLocks()),
    createRateLock: treasuryProcedure
      .input(z.object({ marketObservationId: z.number().int().positive(), paymentOrderId: z.number().int().positive().optional(), corridor, expiresAt: z.coerce.date() }))
      .mutation(({ ctx, input }) => db.createRateLock(actorOf(ctx.user), input)),
    cancelRateLock: treasuryProcedure
      .input(z.object({ rateLockId: z.number().int().positive() }))
      .mutation(({ ctx, input }) => db.cancelRateLock(actorOf(ctx.user), input.rateLockId)),
  }),

  payments: router({
    list: auditorProcedure.query(() => db.listPaymentOrders()),
    listLegs: auditorProcedure.input(z.object({ paymentOrderId: z.number().int().positive().optional() }).optional()).query(({ input }) => db.listPaymentLegs(input?.paymentOrderId)),
    create: treasuryProcedure
      .input(z.object({ idempotencyKey: z.string().trim().min(16).max(255), customerId: z.number().int().positive(), beneficiaryId: z.number().int().positive(), corridor, sourceCurrency: currency, sourceAmount: decimal.refine(value => value !== "0", "Amount must be greater than zero"), targetCurrency: currency, targetAmount: decimal.optional() }).refine(value => value.sourceCurrency !== value.targetCurrency, "Source and target currencies must differ"))
      .mutation(() => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Transitional MySQL/TiDB payment drafting is disabled until the canonical PostgreSQL UUID workflow is implemented." }); }),
    createLeg: treasuryProcedure
      .input(z.object({ paymentOrderId: z.number().int().positive(), sequenceNumber: z.number().int().positive(), legKind: z.enum(["collection", "fx", "stablecoin_settlement", "payout", "reversal"]), counterpartyId: z.number().int().positive().optional() }))
      .mutation(() => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Transitional MySQL/TiDB payment-leg creation is disabled until the canonical PostgreSQL UUID workflow is implemented." }); }),
    transitionLeg: treasuryProcedure
      .input(z.object({ paymentLegId: z.number().int().positive(), status: z.enum(["blocked", "cancelled"]) }))
      .mutation(() => { throw new TRPCError({ code: "PRECONDITION_FAILED", message: "Transitional MySQL/TiDB payment-leg transitions are disabled until the canonical PostgreSQL UUID workflow is implemented." }); }),
  }),

  compliance: router({
    list: auditorProcedure.query(() => db.listComplianceCases()),
    create: complianceProcedure
      .input(z.object({ paymentOrderId: z.number().int().positive().optional(), customerId: z.number().int().positive().optional(), caseType: z.enum(["kyc", "sanctions", "transaction_monitoring", "travel_rule", "counterparty", "sar_str"]), status: z.enum(["open", "under_review", "cleared", "escalated", "reported", "closed"]).default("open"), severity: z.enum(["low", "medium", "high", "critical"]), sourceReference: z.string().url(), decisionReason: z.string().trim().min(4).optional() }))
      .mutation(({ ctx, input }) => db.createComplianceCase(actorOf(ctx.user), input)),
  }),

  reporting: router({
    list: auditorProcedure.query(() => db.listRegulatoryReports()),
    create: complianceProcedure
      .input(z.object({ regulator: z.enum(["CBN", "CBK", "SARB"]), corridor, reportType: z.string().trim().min(4).max(255), periodStart: z.coerce.date(), periodEnd: z.coerce.date() }).refine(value => value.periodEnd >= value.periodStart, "The reporting period end must not precede its start"))
      .mutation(({ ctx, input }) => db.createRegulatoryReport(actorOf(ctx.user), input)),
    listDeadlines: auditorProcedure.query(() => db.listRegulatoryDeadlines()),
    createDeadline: complianceProcedure
      .input(z.object({ regulator: z.enum(["CBN", "CBK", "SARB"]), corridor, title: z.string().trim().min(4).max(255), dueAt: z.coerce.date(), sourceReference: z.string().url() }))
      .mutation(({ ctx, input }) => db.createRegulatoryDeadline(actorOf(ctx.user), input)),
  }),

  alerts: router({
    list: auditorProcedure.query(() => db.listAlertPolicies()),
    create: adminProcedure
      .input(z.object({ alertType: z.enum(["liquidity_threshold", "payment_failure", "compliance_flag", "regulatory_deadline"]), corridor: corridor.optional(), threshold: z.record(z.string(), z.unknown()), enabled: z.boolean().default(true) }))
      .mutation(({ ctx, input }) => db.createAlertPolicy(actorOf(ctx.user), input)),
    evaluateDeadlines: adminProcedure.mutation(({ ctx }) => db.evaluateRegulatoryDeadlineAlerts(actorOf(ctx.user))),
    configureDeadlineReminders: adminProcedure
      .input(z.object({ cronExpression: z.string().regex(/^\d+\s+\d+\s+\d+\s+\*\s+\*\s+\*$/, "Use a six-field UTC cron expression with wildcard day fields") }))
      .mutation(async ({ ctx, input }) => {
        const sessionToken = parseCookie(ctx.req.headers.cookie ?? "")[COOKIE_NAME];
        if (!sessionToken) throw new Error("An authenticated session is required to configure a reminder schedule");
        const job = await createHeartbeatJob({
          name: "umojaflowos-regulatory-deadline-reminders",
          cron: input.cronExpression,
          path: "/api/scheduled/regulatory-deadline-reminders",
          description: "Evaluates CBN, CBK, and SARB reporting deadlines and sends configured owner alerts.",
        }, sessionToken);
        return db.createRegulatoryDeadlineReminderJob(actorOf(ctx.user), { taskUid: job.taskUid, cronExpression: input.cronExpression });
      }),
  }),
});
