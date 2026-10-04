import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

/**
 * Coverage-closing routers (stakeholder / administratorKyc / tradeControl /
 * enterpriseGovernance / controlAssurance / executionRehearsal /
 * ledgerReconciliation / livePipelines) — verifies:
 *   1. every procedure exists on the app router (no orphaned surface),
 *   2. role gates refuse unauthorised callers before any database touch,
 *   3. input validation rejects malformed payloads before any database touch.
 *
 * These tests never connect to PostgreSQL: RBAC and zod run first.
 */

function caller(role: string) {
  return appRouter.createCaller({
    user: { openId: `coverage-${role}`, role, name: role, email: `${role}@example.com` },
    req: {} as never,
    res: { cookie: () => undefined, clearCookie: () => undefined } as never,
  } as never);
}

const ID = "00000000-0000-0000-0000-000000000000";
const SHA = "a".repeat(64);

describe("platform coverage routers — surface completeness", () => {
  it("exposes every new coverage router", () => {
    const router = appRouter as unknown as Record<string, unknown>;
    for (const name of ["stakeholder", "administratorKyc", "tradeControl", "enterpriseGovernance", "controlAssurance", "executionRehearsal", "ledgerReconciliation", "livePipelines"]) {
      expect(router, name).toHaveProperty(name);
    }
  });
});

describe("platform coverage routers — RBAC refusals", () => {
  it("refuses stakeholder account administration for non-admin roles", async () => {
    for (const role of ["compliance_officer", "treasury_operator", "auditor", "provider_contact", "cbn_liaison"]) {
      const client = caller(role) as any;
      await expect(client.stakeholder.transitionAccount({ accountId: ID, target: "suspended", reason: "suspicious sign-in pattern" }))
        .rejects.toThrow(/permission|FORBIDDEN|denied/i);
      await expect(client.stakeholder.assignSuperAdministrator({ subject: "op_999" }))
        .rejects.toThrow(/permission|FORBIDDEN|denied/i);
    }
  });

  it("refuses administrator KYC review recording for non-compliance roles", async () => {
    for (const role of ["treasury_operator", "auditor", "admin"]) {
      const client = caller(role) as any;
      await expect(client.administratorKyc.recordReview({ administratorAccountId: ID, outcome: "approved", rationale: "x".repeat(20) }))
        .rejects.toThrow(/permission|FORBIDDEN|denied/i);
    }
  });

  it("refuses trade-case creation for read-only roles", async () => {
    for (const role of ["auditor", "provider_contact", "cbn_liaison"]) {
      const client = caller(role) as any;
      await expect(client.tradeControl.createCase({
        caseReference: "TPC-ABC123", legalEntityId: ID, corridor: "NGN-USD",
        purchaseCurrency: "NGN", purchaseAmount: "1000.00", intendedSettlementCurrency: "USD",
        purposeSummary: "Import of documented goods with full evidence.",
      })).rejects.toThrow(/permission|FORBIDDEN|denied/i);
    }
  });

  it("refuses trade evidence review for treasury (compliance-only gate)", async () => {
    const client = caller("treasury_operator") as any;
    await expect(client.tradeControl.reviewEvidence({ evidenceId: ID, decision: "accepted", rationale: "x".repeat(20) }))
      .rejects.toThrow(/permission|FORBIDDEN|denied/i);
  });

  it("refuses enterprise governance mutations for non-treasury roles", async () => {
    for (const role of ["compliance_officer", "auditor"]) {
      const client = caller(role) as any;
      await expect(client.enterpriseGovernance.registerGovernedBankAccount({
        legalEntityId: ID, counterpartyId: ID, integrationConnectionId: ID,
        countryCode: "NG", currency: "NGN", accountReferenceHash: SHA,
        mandateEvidenceUri: "https://evidence.example/mandate", mandateEvidenceSha256: SHA,
      })).rejects.toThrow(/permission|FORBIDDEN|denied/i);
    }
  });

  it("refuses control assurance recording for roles outside admin/auditor", async () => {
    for (const role of ["compliance_officer", "treasury_operator"]) {
      const client = caller(role) as any;
      await expect(client.controlAssurance.recordAssessment({
        assessmentKind: "control_coverage", subjectType: "trade_case", subjectId: ID,
        outcome: "covered", findingCodes: [], evidenceUri: "https://evidence.example/a", evidenceSha256: SHA,
      })).rejects.toThrow(/permission|FORBIDDEN|denied/i);
    }
  });

  it("refuses settlement attempt recording for compliance (treasury gate)", async () => {
    const client = caller("compliance_officer") as any;
    await expect(client.executionRehearsal.recordSettlementAttempt({
      paymentOrderId: ID, paymentLegId: ID, idempotencyKey: "idem-12345678", payloadSha256: SHA,
      direction: "onramp", asset: "USDC", fiatCurrency: "NGN", amountMinor: "1000",
    })).rejects.toThrow(/permission|FORBIDDEN|denied/i);
  });

  it("refuses ledger reconciliation run recording for treasury (assurance gate)", async () => {
    const client = caller("treasury_operator") as any;
    await expect(client.ledgerReconciliation.recordRun({
      runReference: "run-2026-09-25-01", windowStart: new Date("2026-09-25T00:00:00Z"), windowEnd: new Date("2026-09-25T01:00:00Z"),
      status: "reconciled", intentCount: 1, factCount: 1, discrepancyCount: 0, sourceIdentity: "reconciler-1",
    })).rejects.toThrow(/permission|FORBIDDEN|denied/i);
  });

  it("refuses provider send recording for read-only roles", async () => {
    const client = caller("auditor") as any;
    await expect(client.livePipelines.recordProviderSend({
      paymentOrderId: ID, paymentLegId: ID, integrationConnectionId: ID,
      providerReference: "prov-1234", providerStatus: "accepted", requestSha256: SHA,
    })).rejects.toThrow(/permission|FORBIDDEN|denied/i);
  });
});

describe("platform coverage routers — input validation before persistence", () => {
  it("rejects malformed sha256 evidence pointers", async () => {
    const client = caller("compliance_officer") as any;
    await expect(client.tradeControl.submitEvidence({
      tradeCaseId: ID, evidenceKind: "purchase_order",
      evidenceUri: "https://evidence.example/po", evidenceSha256: "not-a-sha",
    })).rejects.toThrow(/hex|sha/i);
    await expect(client.administratorKyc.submitEvidence({
      administratorAccountId: ID, evidenceKind: "identity_document",
      jurisdictionCode: "NG", referenceSha256: "XYZ",
    })).rejects.toThrow(/hex|sha/i);
  });

  it("rejects non-HTTPS evidence URIs", async () => {
    const client = caller("admin") as any;
    await expect(client.tradeControl.submitEvidence({
      tradeCaseId: ID, evidenceKind: "purchase_order",
      evidenceUri: "http://insecure.example/po", evidenceSha256: SHA,
    })).rejects.toThrow(/https/i);
  });

  it("rejects invalid trade case references and usernames", async () => {
    const client = caller("compliance_officer") as any;
    await expect(client.tradeControl.createCase({
      caseReference: "BAD-REF", legalEntityId: ID, corridor: "NGN-USD",
      purchaseCurrency: "NGN", purchaseAmount: "1000.00", intendedSettlementCurrency: "USD",
      purposeSummary: "Import of documented goods with full evidence.",
    })).rejects.toThrow(/invalid|regex|caseReference/i);
    const anon = appRouter.createCaller({
      user: null, req: {} as never,
      res: { cookie: () => undefined, clearCookie: () => undefined } as never,
    } as never) as any;
    await expect(anon.stakeholder.requestAccount({
      username: "Invalid Username!", displayName: "Bad Actor", password: "short",
      requestedRole: "auditor",
    })).rejects.toThrow();
  });

  it("rejects indeterminate reconciliation runs without an error summary", async () => {
    const client = caller("auditor") as any;
    await expect(client.ledgerReconciliation.recordRun({
      runReference: "run-2026-09-25-02", windowStart: new Date("2026-09-25T00:00:00Z"), windowEnd: new Date("2026-09-25T01:00:00Z"),
      status: "indeterminate", intentCount: 1, factCount: 1, discrepancyCount: 0, sourceIdentity: "reconciler-1",
    })).rejects.toThrow();
  });
});
