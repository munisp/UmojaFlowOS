/**
 * Live cross-language regression for the Python reporting service.
 *
 * Counterpart to `rustServiceBridge.live.test.ts`. It starts the real FastAPI
 * application with uvicorn and drives it through the real bridge and the real
 * strict contract parsers, which is the only way to prove the two languages
 * agree on the wire format. A renamed field or a changed envelope type would
 * pass every schema-only test and fail here.
 *
 * Opt-in via PYTHON_SERVICE_LIVE_TEST=1 so an absent Python environment is
 * skipped rather than mistaken for evidence.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { assembleReportViaService, computeStablecoinExposureViaService } from "./serviceBridge";

const SERVICE_DIR = resolve(process.cwd(), "../UmojaFlowOS/services/reporting-analytics");
const RUN_LIVE = process.env.PYTHON_SERVICE_LIVE_TEST === "1" && existsSync(SERVICE_DIR);
const describeLive = RUN_LIVE ? describe : describe.skip;

const PORT = 18_183;
const BASE_URL = `http://127.0.0.1:${PORT}`;

describeLive("live Python reporting service through the real service bridge", () => {
  let child: ChildProcess | undefined;
  const env = { UMOJA_REPORTING_URL: BASE_URL } as NodeJS.ProcessEnv;

  beforeAll(async () => {
    child = spawn(
      "python3",
      [
        "-m",
        "uvicorn",
        "umojaflowos_reporting.service:app",
        "--host",
        "127.0.0.1",
        "--port",
        String(PORT),
      ],
      {
        cwd: SERVICE_DIR,
        env: { ...process.env, PYTHONPATH: resolve(SERVICE_DIR, "src") },
        stdio: "ignore",
      },
    );

    const deadline = Date.now() + 30_000;
    for (;;) {
      try {
        const response = await fetch(`${BASE_URL}/healthz`);
        if (response.ok) break;
      } catch {
        // not yet listening
      }
      if (Date.now() > deadline) throw new Error("Python service did not start within 30s");
      await new Promise(done => setTimeout(done, 250));
    }
  }, 120_000);

  afterAll(() => {
    child?.kill("SIGTERM");
  });

  /** A CBN return over two reconciled NGN transactions. */
  function cbnAssemblyRequest() {
    return {
      regulator: "CBN",
      report_type: "cross_border_settlement_return",
      period_start: "2026-02-01",
      period_end: "2026-02-28",
      regulated_entity_id: "entity-live-bridge",
      transactions: [
        {
          transaction_reference: "live-inbound-1",
          value_date: "2026-02-03",
          currency: "NGN",
          amount: "500000.00",
          direction: "inbound",
          counterparty_reference: "cp-live-1",
        },
        {
          transaction_reference: "live-outbound-1",
          value_date: "2026-02-10",
          currency: "NGN",
          amount: "125000.00",
          direction: "outbound",
          counterparty_reference: "cp-live-2",
        },
      ],
    };
  }

  it("returns a contract-valid assembled CBN return bound to the Nigerian corridor", async () => {
    const outcome = await assembleReportViaService(cbnAssemblyRequest(), { env });

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.envelope_type).toBe("umojaflowos.reporting.assembled_report.v1");
    expect(outcome.result.regulator).toBe("CBN");
    // The parser independently rejects a regulator paired with a corridor it
    // does not supervise, so this also proves the pairing is coherent.
    expect(outcome.result.corridor).toBe("NIGERIA_NGN");
    expect(outcome.result.settlement_currency).toBe("NGN");
    expect(outcome.result.totals.record_count).toBe(2);
    expect(outcome.result.artifact_digest).toMatch(/^[a-f0-9]{64}$/);
    // Never submitted by the assembler.
    expect(outcome.result.submission_state).toBe("assembled_pending_review");
  });

  it("produces a stable artifact digest for identical inputs", async () => {
    const first = await assembleReportViaService(cbnAssemblyRequest(), { env });
    // Re-order the transactions: the digest is defined over sorted rows, so a
    // caller's ordering must not change the artifact identity.
    const reordered = cbnAssemblyRequest();
    reordered.transactions.reverse();
    const second = await assembleReportViaService(reordered, { env });

    expect(first.status).toBe("ok");
    expect(second.status).toBe("ok");
    if (first.status !== "ok" || second.status !== "ok") return;
    expect(second.result.artifact_digest).toBe(first.result.artifact_digest);
  });

  it("treats a currency that contradicts the regulator's settlement currency as unavailable", async () => {
    const request = cbnAssemblyRequest();
    request.transactions[0].currency = "ZAR";
    const outcome = await assembleReportViaService(request, { env });

    // The service refuses with 422 and the bridge surfaces that as unavailable
    // rather than returning a partially assembled return.
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") return;
    expect(outcome.reason).toContain("422");
  });

  it("returns contract-valid USDC exposure from reconciled positions only", async () => {
    const now = new Date();
    const recent = new Date(now.getTime() - 5 * 60_000).toISOString();
    const outcome = await computeStablecoinExposureViaService(
      {
        as_of: now.toISOString(),
        max_position_age_minutes: 60,
        max_observation_age_minutes: 60,
        positions: [
          {
            corridor: "SOUTH_AFRICA_ZAR",
            asset: "USDT",
            account_reference: "custody-zar-live",
            available_amount: "2500.000000",
            reserved_amount: "500.000000",
            source_reference: "recon-zar-live",
            reconciled_at: recent,
          },
        ],
        peg_observations: [
          {
            asset: "USDT",
            rate_to_usd: "0.9995",
            source_reference: "peg-usdt-live",
            observed_at: recent,
          },
        ],
      },
      { env },
    );

    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    expect(outcome.result.envelope_type).toBe("umojaflowos.reporting.stablecoin_exposure.v1");
    expect(outcome.result.corridor_exposures).toHaveLength(1);
    const line = outcome.result.corridor_exposures[0];
    expect(line.corridor).toBe("SOUTH_AFRICA_ZAR");
    expect(line.asset).toBe("USDT");
    expect(line.total_amount).toBe("3000.000000");
    // Peg deviation is reported as an observation in basis points, never applied
    // as a valuation adjustment that would restate the position.
    expect(line.peg_deviation_basis_points).toBe(-5);
    expect(line.source_references).toEqual(["recon-zar-live"]);
  });

  it("treats a stale position as unavailable rather than reporting stale exposure", async () => {
    const now = new Date();
    const stale = new Date(now.getTime() - 3 * 24 * 60 * 60_000).toISOString();
    const outcome = await computeStablecoinExposureViaService(
      {
        as_of: now.toISOString(),
        max_position_age_minutes: 60,
        max_observation_age_minutes: 60,
        positions: [
          {
            corridor: "KENYA_KES",
            asset: "USDC",
            account_reference: "custody-kes-live",
            available_amount: "100.000000",
            reserved_amount: "0.000000",
            source_reference: "recon-kes-live",
            reconciled_at: stale,
          },
        ],
        peg_observations: [
          {
            asset: "USDC",
            rate_to_usd: "1.0000",
            source_reference: "peg-usdc-live",
            observed_at: new Date(now.getTime() - 60_000).toISOString(),
          },
        ],
      },
      { env },
    );

    expect(outcome.status).toBe("unavailable");
  });
});
