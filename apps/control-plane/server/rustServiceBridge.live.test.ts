/**
 * Live cross-language regression: the compiled Rust risk core answering the
 * exact routes the TypeScript bridge calls, over real HTTP, with the real
 * versioned contract parsers.
 *
 * Everything else in the suite exercises the bridge against controlled fetch
 * behaviour, which proves the fail-closed paths but cannot prove that the Rust
 * service actually emits a payload the contract accepts. The two languages
 * could drift — a renamed field, a changed enum spelling, a missing envelope
 * type — and every existing test would still pass. This test builds and runs
 * the real binary and asserts the round trip.
 *
 * It is opt-in via RUST_SERVICE_LIVE_TEST=1 because it requires a Rust
 * toolchain. When the toolchain is absent the test is skipped rather than
 * silently passing, so an absent toolchain can never be mistaken for evidence.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  assessCounterpartyRiskViaService,
  evaluateMonitoringViaService,
  resolveServiceEndpoint,
} from "./serviceBridge";

const RUN_LIVE = process.env.RUST_SERVICE_LIVE_TEST === "1";
const CRATE_DIR = resolve(process.cwd(), "../UmojaFlowOS/services/risk-compliance-core");
const describeLive = RUN_LIVE && existsSync(CRATE_DIR) ? describe : describe.skip;

/** A port unlikely to collide with the dev server or any other local service. */
const PORT = 18_182;
const BASE_URL = `http://127.0.0.1:${PORT}`;

describeLive("live Rust risk core through the real service bridge", () => {
  let child: ChildProcess | undefined;
  const env = { UMOJA_RISK_CORE_URL: BASE_URL } as NodeJS.ProcessEnv;

  beforeAll(async () => {
    const cargo = resolve(process.env.HOME ?? "/home/ubuntu", ".cargo/bin/cargo");
    execFileSync(cargo, ["build", "--bin", "risk-compliance-core"], {
      cwd: CRATE_DIR,
      stdio: "ignore",
    });
    child = spawn(resolve(CRATE_DIR, "target/debug/risk-compliance-core"), {
      cwd: CRATE_DIR,
      env: { ...process.env, PORT: String(PORT) },
      stdio: "ignore",
    });

    // Wait for the listener rather than sleeping a fixed interval.
    const deadline = Date.now() + 20_000;
    for (;;) {
      try {
        const response = await fetch(`${BASE_URL}/healthz`);
        if (response.ok) break;
      } catch {
        // not yet listening
      }
      if (Date.now() > deadline) throw new Error("Rust service did not start within 20s");
      await new Promise(done => setTimeout(done, 250));
    }
  }, 300_000);

  afterAll(() => {
    child?.kill("SIGTERM");
  });

  it("accepts the loopback endpoint under the bridge's transport policy", () => {
    expect(resolveServiceEndpoint("risk-compliance-core", env)).toBe(BASE_URL);
  });

  it("returns a contract-valid BLOCK when every monitoring input is absent", async () => {
    const outcome = await evaluateMonitoringViaService(
      {
        corridor: "NIGERIA_NGN",
        amount_minor_units: null,
        reporting_threshold_minor_units: null,
        customer_transactions_in_window: null,
        max_transactions_per_window: null,
        customer_value_in_window_minor_units: null,
        max_value_per_window_minor_units: null,
        counterparty_licence_verified: null,
        beneficiary_jurisdiction_expected: null,
      },
      { env },
    );

    // `ok` here means the Rust payload satisfied the strict versioned schema and
    // the extra invariant that unavailable inputs cannot accompany an ALLOW.
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.decision).toBe("BLOCK");
    expect(outcome.result.service).toBe("umojaflowos-risk-compliance-core");
    expect(outcome.result.contract_version).toBe("v1");
    expect(
      outcome.result.findings.filter(finding =>
        finding.reason_code.startsWith("INPUT_UNAVAILABLE"),
      ).length,
    ).toBeGreaterThan(0);
  });

  it("returns ALLOW only when every monitoring input is supplied and no rule triggers", async () => {
    const outcome = await evaluateMonitoringViaService(
      {
        corridor: "KENYA_KES",
        amount_minor_units: 1_000,
        reporting_threshold_minor_units: 1_000_000,
        customer_transactions_in_window: 1,
        max_transactions_per_window: 10,
        customer_value_in_window_minor_units: 1_000,
        max_value_per_window_minor_units: 5_000_000,
        counterparty_licence_verified: true,
        beneficiary_jurisdiction_expected: true,
      },
      { env },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.decision).toBe("ALLOW");
    // An ALLOW is a monitoring outcome, not a settlement authorisation: no
    // finding may claim otherwise, and every rule must have been evaluated.
    expect(outcome.result.findings.every(finding => !finding.triggered)).toBe(true);
    expect(outcome.result.findings.length).toBe(6);
  });

  it("escalates a triggered monitoring rule to manual review rather than allowing it", async () => {
    const outcome = await evaluateMonitoringViaService(
      {
        corridor: "SOUTH_AFRICA_ZAR",
        amount_minor_units: 1_000,
        reporting_threshold_minor_units: 1_000_000,
        customer_transactions_in_window: 1,
        max_transactions_per_window: 10,
        customer_value_in_window_minor_units: 1_000,
        max_value_per_window_minor_units: 5_000_000,
        // The counterparty holds no verified licence record.
        counterparty_licence_verified: false,
        beneficiary_jurisdiction_expected: true,
      },
      { env },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.decision).not.toBe("ALLOW");
    expect(
      outcome.result.findings.some(
        finding => finding.rule_id === "TM-05-COUNTERPARTY-LICENCE" && finding.triggered,
      ),
    ).toBe(true);
  });

  it("returns an undetermined, review-required band when no counterparty evidence exists", async () => {
    const outcome = await assessCounterpartyRiskViaService(
      {
        licence_status: null,
        licence_within_validity_window: null,
        sanctions_clear: null,
        adverse_findings_recorded: null,
        days_since_last_review: null,
        review_interval_days: null,
      },
      { env },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    // The contract parser itself refuses an undetermined band that does not
    // demand review, or that fails to state which evidence was missing.
    expect(outcome.result.band).toBe("UNDETERMINED");
    expect(outcome.result.review_required).toBe(true);
    expect(outcome.result.reason_codes.length).toBeGreaterThan(0);
  });

  it("treats a suspended licence as prohibitive rather than merely high risk", async () => {
    const outcome = await assessCounterpartyRiskViaService(
      {
        licence_status: "SUSPENDED",
        licence_within_validity_window: true,
        sanctions_clear: true,
        adverse_findings_recorded: false,
        days_since_last_review: 1,
        review_interval_days: 365,
      },
      { env },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.band).toBe("PROHIBITED");
    expect(outcome.result.review_required).toBe(true);
  });

  it("reports the service as unavailable, never as permissive, once it stops answering", async () => {
    const outcome = await evaluateMonitoringViaService(
      {
        corridor: "NIGERIA_NGN",
        amount_minor_units: 1,
        reporting_threshold_minor_units: 2,
        customer_transactions_in_window: 0,
        max_transactions_per_window: 1,
        customer_value_in_window_minor_units: 1,
        max_value_per_window_minor_units: 2,
        counterparty_licence_verified: true,
        beneficiary_jurisdiction_expected: true,
      },
      // A port with nothing listening stands in for the service being down.
      { env: { UMOJA_RISK_CORE_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv, timeoutMs: 2_000 },
    );

    expect(outcome.status).toBe("unavailable");
    expect(JSON.stringify(outcome)).not.toContain("ALLOW");
  });
});
