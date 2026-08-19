import { describe, expect, it } from "vitest";
import {
  resolveServiceEndpoint,
  describeServiceConfiguration,
  evaluateMonitoringViaService,
  assessCounterpartyRiskViaService,
  validateLedgerPostingsViaService,
  reconcileLedgerProjectionViaService,
  ServiceBridgeConfigurationError,
  type MonitoringInput,
} from "./serviceBridge";

const MONITORING_INPUT: MonitoringInput = {
  corridor: "NIGERIA_NGN",
  amount_minor_units: 5_000_000,
  reporting_threshold_minor_units: 1_000_000,
  customer_transactions_in_window: 2,
  max_transactions_per_window: 10,
  customer_value_in_window_minor_units: 5_000_000,
  max_value_per_window_minor_units: 50_000_000,
  counterparty_licence_verified: true,
  beneficiary_jurisdiction_expected: true,
};

describe("service endpoint resolution", () => {
  it("treats an unset endpoint as disabled rather than defaulting to localhost", () => {
    expect(resolveServiceEndpoint("risk-compliance-core", {})).toBeNull();
    expect(resolveServiceEndpoint("risk-compliance-core", { UMOJA_RISK_CORE_URL: "  " })).toBeNull();
  });

  it("permits plain HTTP only on loopback", () => {
    expect(
      resolveServiceEndpoint("risk-compliance-core", {
        UMOJA_RISK_CORE_URL: "http://127.0.0.1:8081",
      }),
    ).toBe("http://127.0.0.1:8081");

    expect(() =>
      resolveServiceEndpoint("risk-compliance-core", {
        UMOJA_RISK_CORE_URL: "http://risk.internal.example:8081",
      }),
    ).toThrow(ServiceBridgeConfigurationError);

    expect(
      resolveServiceEndpoint("risk-compliance-core", {
        UMOJA_RISK_CORE_URL: "https://risk.internal.example",
      }),
    ).toBe("https://risk.internal.example");
  });

  it("refuses credentials embedded in the endpoint URL", () => {
    expect(() =>
      resolveServiceEndpoint("reporting-analytics", {
        UMOJA_REPORTING_URL: "https://user:secret@reporting.internal.example",
      }),
    ).toThrow(/must not embed credentials/i);
  });

  it("reports configuration state for every service without calling any of them", () => {
    const described = describeServiceConfiguration({
      UMOJA_RISK_CORE_URL: "http://127.0.0.1:8081",
    });
    // Four bridged services: the Go payment engine, the Rust risk core, the Rust
    // ledger gateway, and the Python reporting service.
    expect(described).toHaveLength(4);
    expect(described.find(d => d.service === "risk-compliance-core")?.configured).toBe(true);
    expect(described.find(d => d.service === "payment-engine")?.configured).toBe(false);
    expect(described.find(d => d.service === "reporting-analytics")?.configured).toBe(false);
    expect(described.find(d => d.service === "ledger-gateway")?.configured).toBe(false);
  });
});

describe("service bridge fail-closed behaviour", () => {
  it("reports not_configured and performs no network call when the endpoint is unset", async () => {
    let called = false;
    const outcome = await evaluateMonitoringViaService(MONITORING_INPUT, {
      env: {},
      fetchImpl: (async () => {
        called = true;
        throw new Error("must not be reached");
      }) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("not_configured");
    expect(called).toBe(false);
  });

  it("treats a non-2xx response as unavailable rather than an empty result", async () => {
    const outcome = await evaluateMonitoringViaService(MONITORING_INPUT, {
      env: { UMOJA_RISK_CORE_URL: "http://127.0.0.1:8081" },
      fetchImpl: (async () => new Response("upstream failure", { status: 503 })) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toMatch(/HTTP 503/);
  });

  it("treats an unreachable service as unavailable, never as a pass", async () => {
    const outcome = await assessCounterpartyRiskViaService(
      {
        licence_status: "VERIFIED",
        licence_within_validity_window: true,
        sanctions_clear: true,
        adverse_findings_recorded: false,
        days_since_last_review: 10,
        review_interval_days: 365,
      },
      {
        env: { UMOJA_RISK_CORE_URL: "http://127.0.0.1:8081" },
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED");
        }) as unknown as typeof fetch,
      },
    );
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toMatch(/could not be reached/i);
  });

  it("discards a drifted response entirely instead of using part of it", async () => {
    // Well-formed JSON, wrong contract: an extra field plus a missing required one.
    const drifted = {
      service: "umojaflowos-risk-compliance-core",
      contract_version: "v1",
      envelope_type: "umojaflowos.risk.monitoring_result.v1",
      decision: "ALLOW",
      findings: [{ rule_id: "REPORTING_THRESHOLD", triggered: false, reason_code: "WITHIN_LIMIT" }],
      unexpected_directive: "settle_now",
    };
    const outcome = await evaluateMonitoringViaService(MONITORING_INPUT, {
      env: { UMOJA_RISK_CORE_URL: "http://127.0.0.1:8081" },
      fetchImpl: (async () =>
        new Response(JSON.stringify(drifted), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toMatch(/contract violation/i);
  });

  it("treats a non-JSON body as unavailable", async () => {
    const outcome = await evaluateMonitoringViaService(MONITORING_INPUT, {
      env: { UMOJA_RISK_CORE_URL: "http://127.0.0.1:8081" },
      fetchImpl: (async () => new Response("<html>gateway</html>", { status: 200 })) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toMatch(/non-JSON/i);
  });

  it("times out rather than hanging an operator request", async () => {
    const outcome = await evaluateMonitoringViaService(MONITORING_INPUT, {
      env: { UMOJA_RISK_CORE_URL: "http://127.0.0.1:8081" },
      timeoutMs: 25,
      fetchImpl: ((_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => {
            const error = new Error("aborted");
            error.name = "AbortError";
            reject(error);
          });
        })) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toMatch(/did not respond within 25ms/);
  });

  it("surfaces a misconfigured endpoint as unavailable rather than silently skipping", async () => {
    const outcome = await evaluateMonitoringViaService(MONITORING_INPUT, {
      env: { UMOJA_RISK_CORE_URL: "http://risk.public.example" },
      fetchImpl: (async () => {
        throw new Error("must not be reached");
      }) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toMatch(/TLS is required/i);
  });

  it("returns a contract-validated result when the service conforms", async () => {
    const conforming = {
      service: "umojaflowos-risk-compliance-core",
      contract_version: "v1",
      envelope_type: "umojaflowos.risk.monitoring_result.v1",
      decision: "MANUAL_REVIEW",
      findings: [
        {
          rule_id: "REPORTING_THRESHOLD",
          triggered: true,
          reason_code: "REPORTING_THRESHOLD_EXCEEDED",
        },
      ],
    };
    const outcome = await evaluateMonitoringViaService(MONITORING_INPUT, {
      env: { UMOJA_RISK_CORE_URL: "http://127.0.0.1:8081" },
      fetchImpl: (async () =>
        new Response(JSON.stringify(conforming), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("ok");
    expect(outcome.status === "ok" && outcome.result.decision).toBe("MANUAL_REVIEW");
  });
});

describe("ledger gateway bridge fail-closed behaviour", () => {
  const POSTINGS = [
    { account_id: "nostro-ngn", currency: "NGN", debit_minor: 1_000, credit_minor: 0 },
    { account_id: "customer-ngn", currency: "NGN", debit_minor: 0, credit_minor: 1_000 },
  ];

  it("performs no network call when the gateway endpoint is unset", async () => {
    let called = false;
    const outcome = await validateLedgerPostingsViaService(POSTINGS, {
      env: {},
      fetchImpl: (async () => {
        called = true;
        throw new Error("must not be reached");
      }) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("not_configured");
    expect(called).toBe(false);
  });

  it("rejects a balanced claim that its own postings contradict", async () => {
    // The service says balanced; the postings do not net to zero. The parser
    // re-derives the net, so this is refused rather than believed. This is the
    // single most important check at this boundary.
    const lying = {
      service: "umojaflowos-ledger-gateway",
      contract_version: "v1",
      envelope_type: "umojaflowos.ledger.posting_validation.v1",
      postings: [
        { account_id: "nostro-ngn", currency: "NGN", debit_minor: 1_000, credit_minor: 0 },
        { account_id: "customer-ngn", currency: "NGN", debit_minor: 0, credit_minor: 900 },
      ],
      balanced: true,
      imbalance: null,
    };
    const outcome = await validateLedgerPostingsViaService(POSTINGS, {
      env: { UMOJA_LEDGER_GATEWAY_URL: "http://127.0.0.1:8083" },
      fetchImpl: (async () =>
        new Response(JSON.stringify(lying), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as unknown as typeof fetch,
    });
    expect(outcome.status).toBe("unavailable");
    expect(outcome.status === "unavailable" && outcome.reason).toMatch(/contract violation/i);
  });

  it("rejects a reconciliation that claims agreement between differing records", async () => {
    const lying = {
      service: "umojaflowos-ledger-gateway",
      contract_version: "v1",
      envelope_type: "umojaflowos.ledger.projection_reconciliation.v1",
      confirmed_fact: {
        transfer_id: 1,
        correlation_id: "corr-1",
        currency: "ZAR",
        amount_minor: 1_000,
        posted_at: "2026-08-18T10:00:00+00:00",
      },
      projection: {
        transfer_id: 1,
        correlation_id: "corr-1",
        currency: "ZAR",
        amount_minor: 999,
        projected_at: "2026-08-18T10:00:01+00:00",
      },
      reconciled: true,
      discrepancy_reason: null,
    };
    const outcome = await reconcileLedgerProjectionViaService(
      {
        confirmed_fact: {
          transfer_id: 1,
          correlation_id: "corr-1",
          currency: "ZAR",
          amount_minor: 1_000,
          posted_at_rfc3339: "2026-08-18T10:00:00+00:00",
        },
        projection: {
          transfer_id: 1,
          correlation_id: "corr-1",
          currency: "ZAR",
          amount_minor: 999,
          projected_at_rfc3339: "2026-08-18T10:00:01+00:00",
        },
      },
      {
        env: { UMOJA_LEDGER_GATEWAY_URL: "http://127.0.0.1:8083" },
        fetchImpl: (async () =>
          new Response(JSON.stringify(lying), {
            status: 200,
            headers: { "content-type": "application/json" },
          })) as unknown as typeof fetch,
      },
    );
    expect(outcome.status).toBe("unavailable");
  });

  it("refuses an empty posting set before any call is made", () => {
    // An empty set cannot be balanced or unbalanced; sending it would invite the
    // service to answer a question that has no meaning. The guard runs before the
    // call is constructed, so it throws synchronously rather than resolving to an
    // outcome, which is the stricter of the two behaviours.
    expect(() => validateLedgerPostingsViaService([], { env: {} })).toThrow(
      /expected array to have >=1 items/,
    );
  });
});
