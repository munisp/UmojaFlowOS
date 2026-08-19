/**
 * Live cross-language regression for the Rust ledger gateway.
 *
 * The gateway is the one service whose output the control plane re-derives
 * arithmetically rather than merely schema-checking: `parseRustLedgerValidation`
 * recomputes the per-currency net, and `parseRustLedgerReconciliation` re-runs
 * the fact-to-projection comparison. A live test is therefore the only way to
 * prove the two independent implementations agree, which is the entire point of
 * having them.
 *
 * Opt-in via LEDGER_GATEWAY_LIVE_TEST=1; skipped, never silently passed, when
 * the crate or Rust toolchain is absent.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  reconcileLedgerProjectionViaService,
  validateLedgerPostingsViaService,
} from "./serviceBridge";

const CRATE_DIR = resolve(process.cwd(), "../UmojaFlowOS/services/ledger-gateway");
const RUN_LIVE = process.env.LEDGER_GATEWAY_LIVE_TEST === "1" && existsSync(CRATE_DIR);
const describeLive = RUN_LIVE ? describe : describe.skip;

const PORT = 18_184;
const BASE_URL = `http://127.0.0.1:${PORT}`;

describeLive("live Rust ledger gateway through the real service bridge", () => {
  let child: ChildProcess | undefined;
  const env = { UMOJA_LEDGER_GATEWAY_URL: BASE_URL } as NodeJS.ProcessEnv;

  beforeAll(async () => {
    const cargo = resolve(process.env.HOME ?? "/home/ubuntu", ".cargo/bin/cargo");
    execFileSync(cargo, ["build", "--bin", "ledger-gateway"], {
      cwd: CRATE_DIR,
      stdio: "ignore",
    });
    child = spawn(resolve(CRATE_DIR, "target/debug/ledger-gateway"), {
      cwd: CRATE_DIR,
      env: { ...process.env, PORT: String(PORT) },
      stdio: "ignore",
    });

    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(`${BASE_URL}/healthz`);
        if (response.ok) break;
      } catch {
        // not yet listening
      }
      if (Date.now() > deadline) throw new Error("ledger gateway did not start within 30s");
      await new Promise(done => setTimeout(done, 250));
    }
  }, 600_000);

  afterAll(() => {
    child?.kill("SIGTERM");
  });

  it("confirms a balanced NGN posting set, with the control plane re-deriving the net", async () => {
    const outcome = await validateLedgerPostingsViaService(
      [
        { account_id: "nostro-ngn", currency: "NGN", debit_minor: 100_000, credit_minor: 0 },
        { account_id: "customer-ngn", currency: "NGN", debit_minor: 0, credit_minor: 100_000 },
      ],
      { env },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.envelope_type).toBe("umojaflowos.ledger.posting_validation.v1");
    expect(outcome.result.balanced).toBe(true);
    expect(outcome.result.imbalance).toBeNull();
  });

  it("reports a KES imbalance with the currency and net the parser independently confirms", async () => {
    const outcome = await validateLedgerPostingsViaService(
      [
        { account_id: "nostro-kes", currency: "KES", debit_minor: 100_000, credit_minor: 0 },
        { account_id: "customer-kes", currency: "KES", debit_minor: 0, credit_minor: 90_000 },
      ],
      { env },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.balanced).toBe(false);
    expect(outcome.result.imbalance).toEqual({ currency: "KES", net_minor: 10_000 });
  });

  it("balances a multi-currency posting set only when every currency nets to zero", async () => {
    // A cross-currency set can balance overall while one leg does not; the
    // gateway must judge per currency, so ZAR is the reported failure here.
    const outcome = await validateLedgerPostingsViaService(
      [
        { account_id: "nostro-zar", currency: "ZAR", debit_minor: 50_000, credit_minor: 0 },
        { account_id: "customer-zar", currency: "ZAR", debit_minor: 0, credit_minor: 40_000 },
        { account_id: "nostro-ngn", currency: "NGN", debit_minor: 10_000, credit_minor: 0 },
        { account_id: "customer-ngn", currency: "NGN", debit_minor: 0, credit_minor: 10_000 },
      ],
      { env },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.balanced).toBe(false);
    expect(outcome.result.imbalance?.currency).toBe("ZAR");
  });

  it("reconciles an agreeing TigerBeetle fact and PostgreSQL projection", async () => {
    const outcome = await reconcileLedgerProjectionViaService(
      {
        confirmed_fact: {
          transfer_id: 42,
          correlation_id: "corr-live-42",
          currency: "ZAR",
          amount_minor: 250_000,
          posted_at_rfc3339: "2026-08-18T10:00:00+00:00",
        },
        projection: {
          transfer_id: 42,
          correlation_id: "corr-live-42",
          currency: "ZAR",
          amount_minor: 250_000,
          projected_at_rfc3339: "2026-08-18T10:00:01+00:00",
        },
      },
      { env },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.envelope_type).toBe("umojaflowos.ledger.projection_reconciliation.v1");
    expect(outcome.result.reconciled).toBe(true);
    expect(outcome.result.discrepancy_reason).toBeNull();
  });

  it("reports a one-minor-unit divergence as a mismatch rather than agreement", async () => {
    const outcome = await reconcileLedgerProjectionViaService(
      {
        confirmed_fact: {
          transfer_id: 42,
          correlation_id: "corr-live-42",
          currency: "ZAR",
          amount_minor: 250_000,
          posted_at_rfc3339: "2026-08-18T10:00:00+00:00",
        },
        projection: {
          transfer_id: 42,
          correlation_id: "corr-live-42",
          currency: "ZAR",
          amount_minor: 249_999,
          projected_at_rfc3339: "2026-08-18T10:00:01+00:00",
        },
      },
      { env },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.reconciled).toBe(false);
    expect(outcome.result.discrepancy_reason).toBe("MISMATCH");
  });

  it("treats an absent projection as a discrepancy, never as a silent pass", async () => {
    const outcome = await reconcileLedgerProjectionViaService(
      {
        confirmed_fact: {
          transfer_id: 77,
          correlation_id: "corr-live-77",
          currency: "NGN",
          amount_minor: 500_000,
          posted_at_rfc3339: "2026-08-18T11:00:00+00:00",
        },
        projection: {
          transfer_id: 0,
          correlation_id: "",
          currency: "",
          amount_minor: 0,
          projected_at_rfc3339: "",
        },
      },
      { env },
    );

    // The projection is incomplete, so the contract's strict minimums refuse the
    // envelope outright: an unprojected transfer can never read as reconciled.
    expect(outcome.status).toBe("unavailable");
    expect(JSON.stringify(outcome)).not.toContain('"reconciled":true');
  });

  it("reports the gateway as unavailable, never as balanced, once it stops answering", async () => {
    const outcome = await validateLedgerPostingsViaService(
      [{ account_id: "a", currency: "NGN", debit_minor: 1, credit_minor: 1 }],
      { env: { UMOJA_LEDGER_GATEWAY_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv, timeoutMs: 2_000 },
    );

    expect(outcome.status).toBe("unavailable");
    expect(JSON.stringify(outcome)).not.toContain('"balanced":true');
  });
});
