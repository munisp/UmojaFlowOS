import { describe, expect, it } from "vitest";
import { appRouter } from "./routers";

/**
 * End-to-end, non-provider workflow coverage for the multi-language boundaries.
 *
 * These exercise the actual router procedures with real caller contexts rather
 * than calling the parser functions directly, so the gate, the input schema, and
 * the contract all participate. No external provider is involved: the services
 * are simply not configured in this environment, which is the state the platform
 * must handle safely.
 */

type Role = "admin" | "compliance_officer" | "treasury_operator" | "auditor";

function ctxFor(role: Role) {
  return {
    user: { id: `wf-${role}`, openId: `wf-${role}`, name: role, role },
    umojaRole: role,
  } as never;
}

describe("multi-language service workflow (no provider configured)", () => {
  it("lets a compliance officer parse a Go audit trail and rejects a tampered chain in the same flow", async () => {
    const caller = appRouter.createCaller(ctxFor("compliance_officer"));

    const h = (n: number) => String(n).repeat(64).slice(0, 64).replace(/[^0-9a-f]/g, "a");
    const event = (
      sequence: number,
      from: string,
      to: string,
      previousHash: string,
      hash: string,
    ) => ({
      sequence,
      order_id: "order-workflow-1",
      corridor: "NIGERIA_NGN",
      from_status: from,
      to_status: to,
      reason: "",
      actor_role: "compliance_officer",
      occurred_at: `2026-08-18T00:00:0${sequence}.000Z`,
      previous_hash: previousHash,
      hash,
    });

    const trail = {
      service: "umojaflowos-payment-engine",
      contract_version: "v1",
      envelope_type: "umojaflowos.payment.audit_trail.v1",
      order_id: "order-workflow-1",
      events: [
        event(1, "DRAFT", "PENDING_POLICY_DECISION", "", h(1)),
        event(2, "PENDING_POLICY_DECISION", "APPROVED", h(1), h(2)),
        event(3, "APPROVED", "EXECUTING", h(2), h(3)),
      ],
    };

    const parsed = await caller.contracts.parseGoAuditTrail(trail);
    expect(parsed.events).toHaveLength(3);

    // Removing the middle event leaves a schema-valid payload with a broken chain.
    await expect(
      caller.contracts.parseGoAuditTrail({
        ...trail,
        events: [trail.events[0], trail.events[2]],
      }),
    ).rejects.toThrow();
  });

  it("refuses contract procedures for an auditor and a treasury operator", async () => {
    for (const role of ["auditor", "treasury_operator"] as const) {
      const caller = appRouter.createCaller(ctxFor(role));
      await expect(caller.contracts.parseRustMonitoringResult({})).rejects.toThrow();
      await expect(caller.contracts.evaluateMonitoringViaService({
        corridor: "KENYA_KES",
        amount_minor_units: 1,
        reporting_threshold_minor_units: 1,
        customer_transactions_in_window: 0,
        max_transactions_per_window: 1,
        customer_value_in_window_minor_units: 0,
        max_value_per_window_minor_units: 1,
        counterparty_licence_verified: true,
        beneficiary_jurisdiction_expected: true,
      })).rejects.toThrow();
    }
  });

  it("reports every service as unconfigured rather than implying a healthy integration", async () => {
    const caller = appRouter.createCaller(ctxFor("auditor"));
    const configuration = await caller.contracts.serviceConfiguration();
    // Go payment engine, Rust risk core, Rust ledger gateway, Python reporting.
    expect(configuration).toHaveLength(4);
    for (const entry of configuration) {
      // This sandbox sets no service endpoints. The important property is that an
      // absent endpoint is reported explicitly, never silently treated as live.
      expect(entry.configured).toBe(false);
      expect(entry.detail).toMatch(/is not set/);
    }
  });

  it("fails closed when a compliance officer invokes an unconfigured service", async () => {
    const caller = appRouter.createCaller(ctxFor("compliance_officer"));
    const outcome = await caller.contracts.evaluateMonitoringViaService({
      corridor: "SOUTH_AFRICA_ZAR",
      amount_minor_units: 10_000_00,
      reporting_threshold_minor_units: 1_000_00,
      customer_transactions_in_window: 1,
      max_transactions_per_window: 5,
      customer_value_in_window_minor_units: 10_000_00,
      max_value_per_window_minor_units: 50_000_00,
      counterparty_licence_verified: true,
      beneficiary_jurisdiction_expected: true,
    });

    // The critical assertion: an unconfigured risk service must not silently
    // resolve to an allow decision. It must be reported as not configured.
    expect(outcome.status).toBe("not_configured");
    expect(JSON.stringify(outcome)).not.toMatch(/"decision"\s*:\s*"ALLOW"/);
  });

  it("rejects a Python assembled report that declares itself submitted", async () => {
    const caller = appRouter.createCaller(ctxFor("compliance_officer"));
    await expect(
      caller.contracts.parsePythonAssembledReport({
        service: "umojaflowos-reporting-analytics",
        contract_version: "v1",
        envelope_type: "umojaflowos.reporting.assembled_report.v1",
        regulator: "CBN",
        corridor: "NIGERIA_NGN",
        period_start: "2026-07-01",
        period_end: "2026-07-31",
        status: "submitted",
        content_digest: "a".repeat(64),
        source_references: ["ledger-export-2026-07"],
      }),
    ).rejects.toThrow();
  });

  it("keeps ledger verification compliance-gated and fails closed when the gateway is unconfigured", async () => {
    const postings = [
      { account_id: "nostro-ngn", currency: "NGN", debit_minor: 1_000, credit_minor: 0 },
      { account_id: "customer-ngn", currency: "NGN", debit_minor: 0, credit_minor: 1_000 },
    ];

    for (const role of ["auditor", "treasury_operator"] as const) {
      const caller = appRouter.createCaller(ctxFor(role));
      await expect(caller.contracts.validateLedgerPostingsViaService(postings)).rejects.toThrow();
    }

    const compliance = appRouter.createCaller(ctxFor("compliance_officer"));
    const outcome = await compliance.contracts.validateLedgerPostingsViaService(postings);

    // An unconfigured gateway must never resolve to a balanced verdict, which
    // would otherwise let an unverified posting set look approved.
    expect(outcome.status).toBe("not_configured");
    expect(JSON.stringify(outcome)).not.toMatch(/"balanced"\s*:\s*true/);
  });
});
