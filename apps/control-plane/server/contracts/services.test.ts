import { describe, expect, it } from "vitest";
import {
  assertNoExecutionAuthority,
  parseGoAuditTrailEnvelope,
  parseRustMonitoringResult,
  parseRustCounterpartyRisk,
  parsePythonAssembledReport,
  parsePythonStablecoinExposure,
  parseRustLedgerValidation,
  parseRustLedgerReconciliation,
} from "./services";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function goTrail(overrides: Record<string, unknown> = {}) {
  return {
    service: "umojaflowos-payment-engine",
    contract_version: "v1",
    envelope_type: "umojaflowos.payment.audit_trail.v1",
    order_id: "order-1",
    events: [
      {
        sequence: 1,
        order_id: "order-1",
        corridor: "NIGERIA_NGN",
        from_status: "DRAFT",
        to_status: "PENDING_POLICY_DECISION",
        reason: "submitted for policy decision",
        actor_role: "treasury_operator",
        occurred_at: "2026-08-18T00:00:00.000Z",
        previous_hash: "",
        hash: HASH_A,
      },
      {
        sequence: 2,
        order_id: "order-1",
        corridor: "NIGERIA_NGN",
        from_status: "PENDING_POLICY_DECISION",
        to_status: "MANUAL_REVIEW",
        reason: "policy decision requires review",
        actor_role: "compliance_officer",
        occurred_at: "2026-08-18T00:01:00.000Z",
        previous_hash: HASH_A,
        hash: HASH_B,
      },
    ],
    ...overrides,
  };
}

describe("Go payment-engine audit trail contract", () => {
  it("accepts a correctly chained trail", () => {
    const parsed = parseGoAuditTrailEnvelope(goTrail());
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[1].previous_hash).toBe(HASH_A);
  });

  it("rejects a trail whose chain was broken by a removed event", () => {
    // Dropping the first event leaves the second claiming a predecessor hash
    // that no longer exists, which is exactly what tampering looks like.
    const tampered = goTrail({ events: goTrail().events.slice(1) });
    expect(() => parseGoAuditTrailEnvelope(tampered)).toThrow(/sequence gap|chain broken/i);
  });

  it("rejects a trail with a reordered or renumbered event", () => {
    const events = goTrail().events.map((event, index) =>
      index === 1 ? { ...event, sequence: 5 } : event,
    );
    expect(() => parseGoAuditTrailEnvelope(goTrail({ events }))).toThrow(/sequence gap/i);
  });

  it("rejects an event belonging to a different order", () => {
    const events = goTrail().events.map((event, index) =>
      index === 1 ? { ...event, order_id: "order-2" } : event,
    );
    expect(() => parseGoAuditTrailEnvelope(goTrail({ events }))).toThrow(/different order/i);
  });

  it("rejects an unknown field rather than ignoring it", () => {
    expect(() =>
      parseGoAuditTrailEnvelope(goTrail({ provider_reference: "psp-123" })),
    ).toThrow();
  });
});

describe("Rust monitoring contract", () => {
  const base = {
    service: "umojaflowos-risk-compliance-core",
    contract_version: "v1",
    envelope_type: "umojaflowos.risk.monitoring_result.v1",
  };

  it("accepts a complete-input ALLOW with no triggered rule", () => {
    const parsed = parseRustMonitoringResult({
      ...base,
      decision: "ALLOW",
      findings: [{ rule_id: "reporting_threshold", triggered: false, reason_code: "BELOW_THRESHOLD" }],
    });
    expect(parsed.decision).toBe("ALLOW");
  });

  it("rejects an ALLOW that also reports unavailable inputs", () => {
    // This is the specific cross-language regression: if the Rust core ever
    // regressed to allowing on incomplete evidence, the boundary catches it.
    expect(() =>
      parseRustMonitoringResult({
        ...base,
        decision: "ALLOW",
        findings: [
          { rule_id: "reporting_threshold", triggered: true, reason_code: "INPUT_UNAVAILABLE_THRESHOLD" },
        ],
      }),
    ).toThrow(/must fail closed/i);
  });

  it("accepts a BLOCK carrying unavailable-input reasons", () => {
    const parsed = parseRustMonitoringResult({
      ...base,
      decision: "BLOCK",
      findings: [
        { rule_id: "velocity_count", triggered: true, reason_code: "INPUT_UNAVAILABLE_VELOCITY" },
      ],
    });
    expect(parsed.decision).toBe("BLOCK");
  });

  it("requires at least one finding so a bare decision cannot be accepted", () => {
    expect(() => parseRustMonitoringResult({ ...base, decision: "BLOCK", findings: [] })).toThrow();
  });
});

describe("Rust counterparty risk contract", () => {
  const base = {
    service: "umojaflowos-risk-compliance-core",
    contract_version: "v1",
    envelope_type: "umojaflowos.risk.counterparty_assessment.v1",
  };

  it("requires review for an undetermined band and states the missing evidence", () => {
    const parsed = parseRustCounterpartyRisk({
      ...base,
      band: "UNDETERMINED",
      reason_codes: ["INPUT_UNAVAILABLE_LICENCE_STATUS"],
      review_required: true,
    });
    expect(parsed.review_required).toBe(true);

    expect(() =>
      parseRustCounterpartyRisk({
        ...base,
        band: "UNDETERMINED",
        reason_codes: ["INPUT_UNAVAILABLE_LICENCE_STATUS"],
        review_required: false,
      }),
    ).toThrow(/must require human review/i);

    expect(() =>
      parseRustCounterpartyRisk({
        ...base,
        band: "UNDETERMINED",
        reason_codes: [],
        review_required: true,
      }),
    ).toThrow(/which evidence was missing/i);
  });

  it("never presents a prohibited counterparty as review-clear", () => {
    expect(() =>
      parseRustCounterpartyRisk({
        ...base,
        band: "PROHIBITED",
        reason_codes: ["LICENCE_SUSPENDED"],
        review_required: false,
      }),
    ).toThrow(/must require human review/i);
  });
});

describe("Python reporting contracts", () => {
  const reportBase = {
    service: "umojaflowos-reporting-analytics",
    contract_version: "v1",
    envelope_type: "umojaflowos.reporting.assembled_report.v1",
    report_type: "cross_border_settlement_summary",
    period_start: "2026-07-01",
    period_end: "2026-07-31",
    regulated_entity_id: "entity-1",
    generated_at: "2026-08-01T00:00:00.000Z",
    totals: { record_count: 2, inbound_total: "100.00", outbound_total: "40.00", net_total: "60.00" },
    artifact_digest: "c".repeat(64),
    submission_state: "assembled_pending_review",
  };

  it("accepts a regulator-consistent assembled report", () => {
    const parsed = parsePythonAssembledReport({
      ...reportBase,
      regulator: "CBK",
      corridor: "KENYA_KES",
      settlement_currency: "KES",
    });
    expect(parsed.submission_state).toBe("assembled_pending_review");
  });

  it("rejects a report filed against a regulator that does not supervise the corridor", () => {
    expect(() =>
      parsePythonAssembledReport({
        ...reportBase,
        regulator: "CBN",
        corridor: "SOUTH_AFRICA_ZAR",
        settlement_currency: "ZAR",
      }),
    ).toThrow(/does not supervise/i);
  });

  it("rejects an inverted reporting period", () => {
    expect(() =>
      parsePythonAssembledReport({
        ...reportBase,
        regulator: "SARB",
        corridor: "SOUTH_AFRICA_ZAR",
        settlement_currency: "ZAR",
        period_start: "2026-07-31",
        period_end: "2026-07-01",
      }),
    ).toThrow(/precedes its start/i);
  });

  it("refuses an assembler-declared submitted state", () => {
    // Only the control plane may record a submission, and only against a
    // verified channel reference.
    expect(() =>
      parsePythonAssembledReport({
        ...reportBase,
        regulator: "CBN",
        corridor: "NIGERIA_NGN",
        settlement_currency: "NGN",
        submission_state: "submitted",
      }),
    ).toThrow();
  });

  it("accepts USDC and USDT exposure with source references and rejects other assets", () => {
    const exposureBase = {
      service: "umojaflowos-reporting-analytics",
      contract_version: "v1",
      envelope_type: "umojaflowos.reporting.stablecoin_exposure.v1",
      generated_at: "2026-08-01T00:00:00.000Z",
      total_usd_equivalent: "1000.00",
      observations: [],
    };
    const entry = {
      corridor: "NIGERIA_NGN",
      asset: "USDC",
      available_amount: "1000.00",
      reserved_amount: "0.00",
      total_amount: "1000.00",
      usd_equivalent: "1000.00",
      peg_deviation_basis_points: 3,
      position_count: 1,
      source_references: ["custodian-statement-2026-08-01"],
    };

    const parsed = parsePythonStablecoinExposure({
      ...exposureBase,
      corridor_exposures: [entry],
    });
    expect(parsed.corridor_exposures[0].asset).toBe("USDC");

    expect(() =>
      parsePythonStablecoinExposure({
        ...exposureBase,
        corridor_exposures: [{ ...entry, asset: "DAI" }],
      }),
    ).toThrow();

    expect(() =>
      parsePythonStablecoinExposure({
        ...exposureBase,
        corridor_exposures: [{ ...entry, source_references: [] }],
      }),
    ).toThrow();
  });
});

describe("execution-authority boundary", () => {
  it("re-derives ledger balance instead of trusting the service flag", () => {
    const base = {
      service: "umojaflowos-ledger-gateway",
      contract_version: "v1",
      envelope_type: "umojaflowos.ledger.posting_validation.v1",
    };
    const balanced = {
      ...base,
      postings: [
        { account_id: "nostro-ngn", currency: "NGN", debit_minor: 500_00, credit_minor: 0 },
        { account_id: "customer-ngn", currency: "NGN", debit_minor: 0, credit_minor: 500_00 },
      ],
      balanced: true,
      imbalance: null,
    };
    expect(parseRustLedgerValidation(balanced).balanced).toBe(true);

    // A service claiming "balanced" over postings that do not net to zero is the
    // exact drift this boundary exists to catch.
    expect(() =>
      parseRustLedgerValidation({
        ...balanced,
        postings: [
          { account_id: "nostro-ngn", currency: "NGN", debit_minor: 500_00, credit_minor: 0 },
          { account_id: "customer-ngn", currency: "NGN", debit_minor: 0, credit_minor: 400_00 },
        ],
      }),
    ).toThrow(/derive balanced=false/i);

    // An unbalanced set must name the currency and net amount.
    expect(() =>
      parseRustLedgerValidation({
        ...base,
        postings: [{ account_id: "nostro-ngn", currency: "NGN", debit_minor: 100, credit_minor: 0 }],
        balanced: false,
        imbalance: null,
      }),
    ).toThrow(/must name the offending currency/i);

    // And the named imbalance must match what the postings actually imply.
    expect(() =>
      parseRustLedgerValidation({
        ...base,
        postings: [{ account_id: "nostro-ngn", currency: "NGN", debit_minor: 100, credit_minor: 0 }],
        balanced: false,
        imbalance: { currency: "NGN", net_minor: 999 },
      }),
    ).toThrow(/does not match the supplied postings/i);
  });

  it("re-verifies the TigerBeetle-to-PostgreSQL projection comparison", () => {
    const base = {
      service: "umojaflowos-ledger-gateway",
      contract_version: "v1",
      envelope_type: "umojaflowos.ledger.projection_reconciliation.v1",
    };
    const fact = {
      transfer_id: 42,
      correlation_id: "order-1",
      currency: "KES",
      amount_minor: 250_00,
      posted_at: "2026-08-18T00:00:00.000Z",
    };
    const projection = {
      transfer_id: 42,
      correlation_id: "order-1",
      currency: "KES",
      amount_minor: 250_00,
      projected_at: "2026-08-18T00:00:01.000Z",
    };

    expect(
      parseRustLedgerReconciliation({
        ...base,
        confirmed_fact: fact,
        projection,
        reconciled: true,
        discrepancy_reason: null,
      }).reconciled,
    ).toBe(true);

    // Claimed agreement over records that differ must be rejected: this is the
    // most dangerous possible drift between the ledger and its projection.
    expect(() =>
      parseRustLedgerReconciliation({
        ...base,
        confirmed_fact: fact,
        projection: { ...projection, amount_minor: 249_00 },
        reconciled: true,
        discrepancy_reason: null,
      }),
    ).toThrow(/claims agreement while/i);

    expect(() =>
      parseRustLedgerReconciliation({
        ...base,
        confirmed_fact: fact,
        projection: { ...projection, amount_minor: 249_00 },
        reconciled: false,
        discrepancy_reason: null,
      }),
    ).toThrow(/must state its discrepancy reason/i);

    expect(() =>
      parseRustLedgerReconciliation({
        ...base,
        confirmed_fact: fact,
        projection,
        reconciled: false,
        discrepancy_reason: "MISMATCH",
      }),
    ).toThrow(/supplied records agree/i);
  });

  it("rejects execution-shaped and credential-shaped keys at any depth", () => {
    expect(() => assertNoExecutionAuthority({ decision: "ALLOW", execute: true })).toThrow(
      /execution authority/i,
    );
    expect(() =>
      assertNoExecutionAuthority({ result: { nested: [{ transfer_instruction: "pay" }] } }),
    ).toThrow(/execution authority/i);
    expect(() => assertNoExecutionAuthority({ provider: { api_key: "secret" } })).toThrow(
      /credentials/i,
    );
    // A legitimate payload passes untouched.
    expect(() =>
      assertNoExecutionAuthority({ decision: "BLOCK", reason_codes: ["INPUT_UNAVAILABLE"] }),
    ).not.toThrow();
  });
});
