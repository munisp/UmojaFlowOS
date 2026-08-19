/**
 * Live cross-language regression for the Go payment engine.
 *
 * Completes the set alongside the Rust and Python live tests: the compiled Go
 * binary answers `/v1/orders/validate` over real HTTP and the response is parsed
 * by the real versioned event contract. Before this existed the Go route
 * returned an ad-hoc `{status, provider_execution}` body that the control
 * plane's strict parser would have refused, and no test could have detected it,
 * because every other test asserted the Go and TypeScript sides separately.
 *
 * Opt-in via GO_SERVICE_LIVE_TEST=1 so an absent Go toolchain is skipped rather
 * than mistaken for evidence.
 */

import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { validatePaymentOrderViaService } from "./serviceBridge";

const SERVICE_DIR = resolve(process.cwd(), "../UmojaFlowOS/services/payment-engine");
const RUN_LIVE = process.env.GO_SERVICE_LIVE_TEST === "1" && existsSync(SERVICE_DIR);
const describeLive = RUN_LIVE ? describe : describe.skip;

const PORT = 18_181;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const BINARY = "/tmp/umojaflowos-payment-engine-live";

describeLive("live Go payment engine through the real service bridge", () => {
  let child: ChildProcess | undefined;
  const env = { UMOJA_PAYMENT_ENGINE_URL: BASE_URL } as NodeJS.ProcessEnv;

  beforeAll(async () => {
    execFileSync("/usr/local/go/bin/go", ["build", "-o", BINARY, "./cmd/payment-engine"], {
      cwd: SERVICE_DIR,
      stdio: "ignore",
    });
    child = spawn(BINARY, {
      cwd: SERVICE_DIR,
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
      if (Date.now() > deadline) throw new Error("Go service did not start within 30s");
      await new Promise(done => setTimeout(done, 250));
    }
  }, 300_000);

  afterAll(() => {
    child?.kill("SIGTERM");
  });

  function order(overrides: Record<string, unknown> = {}) {
    return {
      id: `live-order-${Math.random().toString(16).slice(2)}`,
      idempotency_key: `live-key-${Math.random().toString(16).slice(2)}`,
      corridor: "NIGERIA_NGN",
      source_currency: "NGN",
      source_amount: "100000",
      target_currency: "USD",
      target_amount: "60",
      ...overrides,
    };
  }

  it("returns a contract-valid validated event for each supported corridor", async () => {
    for (const [corridor, currency] of [
      ["NIGERIA_NGN", "NGN"],
      ["KENYA_KES", "KES"],
      ["SOUTH_AFRICA_ZAR", "ZAR"],
    ] as const) {
      const outcome = await validatePaymentOrderViaService(
        order({ corridor, source_currency: currency, correlation_id: `corr-${corridor}` }),
        { env },
      );
      expect(outcome.status).toBe("ok");
      if (outcome.status !== "ok") continue;
      const event = outcome.result as {
        event_type: string;
        schema_version: string;
        correlation_id: string;
      };
      expect(event.event_type).toBe("umojaflowos.payment.order.validated.v1");
      expect(event.schema_version).toBe("v1");
      expect(event.correlation_id).toBe(`corr-${corridor}`);
    }
  });

  it("carries the resulting lifecycle status and no execution authorisation", async () => {
    const outcome = await validatePaymentOrderViaService(
      order({ policy_outcome: "ALLOW", policy_version: "2026.08" }),
      { env },
    );
    expect(outcome.status).toBe("ok");
    if (outcome.status !== "ok") return;
    const event = outcome.result as { payload: unknown };
    const payload = event.payload as {
      status: string;
      provider_execution: string;
    };
    // An ALLOW policy decision approves the order for review, not for
    // settlement: provider execution stays explicitly disabled.
    expect(payload.status).toBe("APPROVED");
    expect(payload.provider_execution).toBe("disabled_without_verified_provider");
  });

  it("reports a refused order as unavailable rather than returning a partial event", async () => {
    const outcome = await validatePaymentOrderViaService(order({ corridor: "" }), { env });
    expect(outcome.status).toBe("unavailable");
    if (outcome.status !== "unavailable") return;
    expect(outcome.reason).toContain("422");
  });

  it("reports the engine as unavailable, never as approved, once it stops answering", async () => {
    const outcome = await validatePaymentOrderViaService(order(), {
      env: { UMOJA_PAYMENT_ENGINE_URL: "http://127.0.0.1:1" } as NodeJS.ProcessEnv,
      timeoutMs: 2_000,
    });
    expect(outcome.status).toBe("unavailable");
    expect(JSON.stringify(outcome)).not.toContain("APPROVED");
  });
});
