import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";
import type { TrpcContext } from "./_core/context";

function auditorContext(): TrpcContext {
  return {
    user: {
      id: 41,
      openId: "audit-user",
      name: "Audit User",
      email: "audit@example.com",
      loginMethod: "manus",
      role: "auditor",
      createdAt: new Date("2026-08-17T00:00:00.000Z"),
      updatedAt: new Date("2026-08-17T00:00:00.000Z"),
      lastSignedIn: new Date("2026-08-17T00:00:00.000Z"),
    },
    req: { protocol: "https", headers: {} } as TrpcContext["req"],
    res: {} as TrpcContext["res"],
  };
}

describe("UmojaFlowOS role boundaries", () => {
  it("prevents an auditor from creating a counterparty", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.umoja.registry.create({ legalName: "Controlled Entity", counterpartyType: "licensed_psp", jurisdiction: "Nigeria" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from recording liquidity", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.umoja.treasury.recordLiquidity({
      corridor: "NIGERIA_NGN",
      currency: "NGN",
      accountKind: "liquidity_pool",
      accountReference: "reconciled-ledger-reference",
      availableAmount: "100.00",
      reservedAmount: "0",
      sourceReference: "reconciliation-evidence-reference",
      reconciledAt: new Date("2026-08-17T00:00:00.000Z"),
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
