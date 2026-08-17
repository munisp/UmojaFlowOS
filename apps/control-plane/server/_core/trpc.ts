import { NOT_ADMIN_ERR_MSG, UNAUTHED_ERR_MSG } from '@shared/const';
import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { TrpcContext } from "./context";

const t = initTRPC.context<TrpcContext>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;

const requireUser = t.middleware(async opts => {
  const { ctx, next } = opts;

  if (!ctx.user) {
    throw new TRPCError({ code: "UNAUTHORIZED", message: UNAUTHED_ERR_MSG });
  }

  return next({
    ctx: {
      ...ctx,
      user: ctx.user,
    },
  });
});

export const protectedProcedure = t.procedure.use(requireUser);

type OperatingRole = "admin" | "compliance_officer" | "treasury_operator" | "auditor";

function procedureForRoles(roles: OperatingRole[]) {
  return t.procedure.use(
    t.middleware(async opts => {
      const { ctx, next } = opts;
      if (!ctx.user || !roles.includes(ctx.user.role)) {
        throw new TRPCError({ code: "FORBIDDEN", message: NOT_ADMIN_ERR_MSG });
      }
      return next({ ctx: { ...ctx, user: ctx.user } });
    }),
  );
}

export const adminProcedure = procedureForRoles(["admin"]);
export const complianceProcedure = procedureForRoles(["admin", "compliance_officer"]);
export const treasuryProcedure = procedureForRoles(["admin", "treasury_operator"]);
export const auditorProcedure = procedureForRoles(["admin", "compliance_officer", "treasury_operator", "auditor"]);
