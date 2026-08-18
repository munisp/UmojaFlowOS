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

  it("prevents an auditor from cancelling a rate lock", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.umoja.markets.cancelRateLock({ rateLockId: 1 })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from changing a payment-leg state", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.umoja.payments.transitionLeg({ paymentLegId: 1, status: "blocked" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from changing a counterparty licence lifecycle", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.umoja.registry.transitionAuthorization({ authorizationId: 1, status: "verified" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from creating a SAR/STR filing", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.postgres.createSarStrFiling({
      complianceCaseId: "00000000-0000-4000-8000-000000000001",
      corridor: "SOUTH_AFRICA_ZAR",
      filingType: "sar",
      filingAuthority: "SARB",
      sourceReference: "case-evidence-reference",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from transitioning a SAR/STR filing", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.postgres.transitionSarStrFiling({
      filingId: "00000000-0000-4000-8000-000000000002",
      status: "under_review",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from changing a KYC document review state", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.postgres.updateKycDocumentReview({
      documentId: "00000000-0000-4000-8000-000000000003",
      reviewStatus: "under_review",
      reviewNote: "Manual review initiated.",
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from initiating a direct-to-S3 KYC document upload", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.postgres.createKycDocumentUploadIntent({
      customerId: "00000000-0000-4000-8000-000000000004",
      documentType: "identity_document",
      originalFilename: "authorised-evidence.pdf",
      mimeType: "application/pdf",
      sizeBytes: 1024,
      contentSha256: "a".repeat(64),
    })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("prevents an auditor from finalizing a direct-to-S3 KYC document upload", async () => {
    const caller = appRouter.createCaller(auditorContext());
    await expect(caller.postgres.finalizeKycDocumentUpload({ uploadIntentId: "00000000-0000-4000-8000-000000000005" })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
