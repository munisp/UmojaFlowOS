import { COOKIE_NAME } from "@shared/const";
import { getSessionCookieOptions } from "./_core/cookies";
import { systemRouter } from "./_core/systemRouter";
import { publicProcedure, router } from "./_core/trpc";
import { auditorProcedure } from "./_core/trpc";
import { getPostgresCutoverReadiness, getPostgresReadiness, listPostgresCounterparties, listPostgresCounterpartyAuthorizations } from "./postgres";
import { umojaFlowRouter } from "./routers/umojaflowos";

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
  }),
  umoja: umojaFlowRouter,
});

export type AppRouter = typeof appRouter;
