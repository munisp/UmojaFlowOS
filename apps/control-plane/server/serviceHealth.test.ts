import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { collectAllServiceStatuses, collectServiceStatus, MONITORED_SERVICES, SERVICE_LANGUAGE } from "./serviceHealth";

/**
 * These run against real HTTP servers rather than a mocked fetch. The behaviour
 * the dashboard depends on — what happens on a 500, a hang, a truncated body, a
 * misconfigured endpoint — lives in the transport, and mocking it would only
 * restate the assumptions already in the code.
 *
 * The property that matters most: an unhealthy service is never rendered as
 * healthy, and no number is ever invented.
 */
let server: Server | undefined;

async function serve(handler: (path: string) => { status: number; body: string }): Promise<string> {
  server = createServer((req, res) => {
    const { status, body } = handler(req.url ?? "/");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(body);
  });
  await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (typeof address === "string" || address === null) throw new Error("no port");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  if (server) {
    await new Promise<void>(resolve => server!.close(() => resolve()));
    server = undefined;
  }
});

const goMetrics = JSON.stringify({
  service: "payment-engine",
  language: "go",
  uptime_seconds: 42,
  validations_total: 7,
  validations_invalid: 2,
  observed_at: "2026-08-18T00:00:00Z",
  provider_execution: "disabled_without_verified_provider",
});

describe("service status collection", () => {
  it("reports an unconfigured service as disabled, not as failing", async () => {
    // This distinction is the whole point: the platform is designed to run with
    // these services switched off, and showing them as red would train
    // operators to ignore red.
    const status = await collectServiceStatus("payment-engine", { env: {} });
    expect(status.status).toBe("not_configured");
    if (status.status === "not_configured") {
      expect(status.reason).toMatch(/no endpoint is configured/);
    }
  });

  it("reports a healthy service with the counters it actually returned", async () => {
    const base = await serve(() => ({ status: 200, body: goMetrics }));
    const status = await collectServiceStatus("payment-engine", {
      env: { UMOJA_PAYMENT_ENGINE_URL: base },
    });
    expect(status.status).toBe("healthy");
    if (status.status !== "healthy") return;
    expect(status.counters.validations_total).toBe(7);
    expect(status.counters.validations_invalid).toBe(2);
    expect(status.uptimeSeconds).toBe(42);
    expect(status.posture.provider_execution).toBe("disabled_without_verified_provider");
    expect(status.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("invents no counter the service did not report", async () => {
    const sparse = JSON.stringify({
      service: "payment-engine",
      language: "go",
      uptime_seconds: 1,
      observed_at: "2026-08-18T00:00:00Z",
    });
    const base = await serve(() => ({ status: 200, body: sparse }));
    const status = await collectServiceStatus("payment-engine", {
      env: { UMOJA_PAYMENT_ENGINE_URL: base },
    });
    expect(status.status).toBe("healthy");
    if (status.status !== "healthy") return;
    // Absent means absent. A zero here would be indistinguishable from a quiet
    // system and would mislead during an incident.
    expect(status.counters.validations_total).toBeUndefined();
    expect(Object.keys(status.counters)).toEqual(["uptime_seconds"]);
  });

  it.each([
    ["a server error", { status: 503, body: "{}" }, /HTTP 503/],
    ["a non-JSON body", { status: 200, body: "not json" }, /non-JSON body/],
    ["metrics of the wrong shape", { status: 200, body: JSON.stringify({ service: "x" }) }, /did not match the expected shape/],
  ])("reports %s as unreachable with a stated reason", async (_label, response, expected) => {
    const base = await serve(() => response);
    const status = await collectServiceStatus("payment-engine", {
      env: { UMOJA_PAYMENT_ENGINE_URL: base },
    });
    expect(status.status).toBe("unreachable");
    if (status.status === "unreachable") expect(status.reason).toMatch(expected);
  });

  it("detects an endpoint pointing at the wrong service", async () => {
    // Pointing the Go endpoint at the Python service is a plausible deployment
    // mistake that would otherwise show as a healthy service reporting
    // meaningless counters.
    const wrong = JSON.stringify({
      service: "reporting-analytics",
      language: "python",
      uptime_seconds: 5,
      observed_at: "2026-08-18T00:00:00Z",
    });
    const base = await serve(() => ({ status: 200, body: wrong }));
    const status = await collectServiceStatus("payment-engine", {
      env: { UMOJA_PAYMENT_ENGINE_URL: base },
    });
    expect(status.status).toBe("unreachable");
    if (status.status === "unreachable") {
      expect(status.reason).toMatch(/reports itself as python.*implemented in go/);
    }
  });

  it("reports an unreachable endpoint rather than throwing", async () => {
    const status = await collectServiceStatus("payment-engine", {
      env: { UMOJA_PAYMENT_ENGINE_URL: "http://127.0.0.1:1" },
    });
    expect(status.status).toBe("unreachable");
  });

  it("refuses a misconfigured endpoint without contacting it", async () => {
    // Plain HTTP off the loopback interface violates the transport rule, and the
    // dashboard must not be the one place that quietly relaxes it.
    const status = await collectServiceStatus("payment-engine", {
      env: { UMOJA_PAYMENT_ENGINE_URL: "http://provider.example.com" },
    });
    expect(status.status).toBe("unreachable");
    if (status.status === "unreachable") expect(status.latencyMs).toBeNull();
  });

  it("times out rather than hanging the dashboard", async () => {
    server = createServer(() => {
      // Never responds.
    });
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (typeof address === "string" || address === null) throw new Error("no port");
    const status = await collectServiceStatus("payment-engine", {
      env: { UMOJA_PAYMENT_ENGINE_URL: `http://127.0.0.1:${address.port}` },
      timeoutMs: 150,
    });
    expect(status.status).toBe("unreachable");
    if (status.status === "unreachable") expect(status.reason).toMatch(/did not respond within 150ms/);
  });

  it("collects every monitored service, including unconfigured ones", async () => {
    const collected = await collectAllServiceStatuses({ env: {} });
    expect(collected.services).toHaveLength(MONITORED_SERVICES.length);
    // A missing service in the list would mean an operator cannot tell whether
    // it is disabled or simply forgotten.
    for (const service of MONITORED_SERVICES) {
      const entry = collected.services.find(row => row.service === service);
      expect(entry).toBeDefined();
      expect(entry?.language).toBe(SERVICE_LANGUAGE[service]);
    }
  });

  it("does not let one failing service prevent the others from reporting", async () => {
    const base = await serve(() => ({ status: 200, body: goMetrics }));
    const collected = await collectAllServiceStatuses({
      env: {
        UMOJA_PAYMENT_ENGINE_URL: base,
        UMOJA_RISK_CORE_URL: "http://127.0.0.1:1",
      },
    });
    const go = collected.services.find(row => row.service === "payment-engine");
    const rust = collected.services.find(row => row.service === "risk-compliance-core");
    expect(go?.status).toBe("healthy");
    expect(rust?.status).toBe("unreachable");
  });
});
