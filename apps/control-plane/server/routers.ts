import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { adminProcedure, auditorProcedure, publicProcedure, router } from "./_core/trpc";
import { createPostgresCounterparty, getPostgresCutoverReadiness, getPostgresReadiness, listPostgresCounterparties, listPostgresCounterpartyAuthorizations } from "./postgres";
import { umojaFlowRouter } from "./routers/umojaflowos";
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
    createCounterparty: adminProcedure.input(z.object({
      legalName: z.string().trim().min(2).max(255),
      counterpartyType: z.enum(["licensed_psp", "correspondent_bank", "stablecoin_provider", "fx_liquidity_provider", "custody_provider", "kyc_provider", "sanctions_provider", "chain_analytics_provider", "notification_provider", "regulatory_submission_provider"]),
      jurisdiction: z.string().trim().min(2).max(64),
    })).mutation(({ ctx, input }) => createPostgresCounterparty({ openId: ctx.user.openId, role: ctx.user.role }, input)),
  }),
  umoja: umojaFlowRouter,
});

export type AppRouter = typeof appRouter;
