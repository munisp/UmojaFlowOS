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

function adminContext(): TrpcContext {
  return {
    ...auditorContext(),
    user: { ...auditorContext().user!, openId: "admin-user", role: "admin" },
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

  it("prevents an auditor from cancelling a rate lock", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.umoja.markets.cancelRateLock({ rateLockId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from changing a payment-leg state", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.umoja.payments.transitionLeg({ paymentLegId: 1, status: "blocked" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("fail-closes transitional payment drafts and payment-leg mutations for an otherwise authorized administrator", async () => {
    const caller = appRouter.createCaller(adminContext());
    await expect(caller.umoja.payments.create({ idempotencyKey: "source-backed-key-0001", customerId: 1, beneficiaryId: 1, corridor: "NIGERIA_NGN", sourceCurrency: "NGN", sourceAmount: "1.00", targetCurrency: "USD" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.umoja.payments.createLeg({ paymentOrderId: 1, sequenceNumber: 1, legKind: "collection" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
    await expect(caller.umoja.payments.transitionLeg({ paymentLegId: 1, status: "blocked" })).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("prevents an auditor from changing a counterparty licence lifecycle", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.umoja.registry.transitionAuthorization({ authorizationId: 1, status: "verified" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from escalating a PostgreSQL counterparty risk assessment", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.umoja.registry.escalatePostgresRiskAssessment({ assessmentId: "00000000-0000-4000-8000-000000000001", reason: "Independent administrator review is required." })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from transitioning a PostgreSQL regulatory report", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.umoja.reporting.transitionPostgresReport({ reportId: "00000000-0000-4000-8000-000000000002", status: "under_review", statusReason: "Evidence package is ready for independent review." })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from creating a canonical SAR/STR filing", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.postgres.createSarStrFiling({ complianceCaseId: "00000000-0000-4000-8000-000000000003", corridor: "SOUTH_AFRICA_ZAR", filingType: "sar", filingAuthority: "SARB", sourceReference: "case-evidence-reference" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from transitioning a canonical SAR/STR filing", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.postgres.transitionSarStrFiling({ filingId: "00000000-0000-4000-8000-000000000004", status: "under_review" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from changing a canonical KYC document review state", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.postgres.updateKycDocumentReview({ documentId: "00000000-0000-4000-8000-000000000005", reviewStatus: "under_review", reviewNote: "Manual review initiated." })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("allows an administrator through the treasury role boundary", async () => {
    const caller = appRouter.createCaller(adminContext());
    const outcome = await caller.umoja.markets.cancelRateLock({ rateLockId: 1 }).then(() => undefined).catch(error => error);
    expect(outcome?.code).not.toBe("FORBIDDEN");
  });

  it("prevents an auditor from parsing Go, Rust, or Python service contracts", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.contracts.parseGoPaymentOrderValidated({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.contracts.parseRustPolicyDecision({})).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(caller.contracts.parsePythonBronzeManifest({})).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
