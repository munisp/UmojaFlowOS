import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectServiceStatus } from "./serviceHealth";

/**
 * Live cross-language verification of the status dashboard's data source.
 *
 * The unit tests exercise every failure mode against synthetic servers. This
 * one does the opposite: it starts the *real* Go, Rust, and Python binaries and
 * confirms the collector reads them correctly. Without it, a service could
 * rename a metrics field and every test would still pass while the dashboard
 * silently showed nothing.
 *
 * Opt-in, because it compiles and runs three services.
 */
const ENABLED = process.env.SERVICE_HEALTH_LIVE_TEST === "1";
const MONOREPO = "/home/ubuntu/UmojaFlowOS";

const processes: ChildProcess[] = [];

async function waitForPort(url: string, attempts = 60): Promise<boolean> {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return true;
    } catch {
      // Not up yet.
    }
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return false;
}

function start(command: string, args: string[], cwd: string, env: Record<string, string>): void {
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: "ignore",
    detached: false,
  });
  processes.push(child);
}

describe.skipIf(!ENABLED)("live service status collection", () => {
  beforeAll(async () => {
    start("go", ["run", "./cmd/payment-engine"], `${MONOREPO}/services/payment-engine`, { PORT: "18181", PATH: `/usr/local/go/bin:${process.env.PATH}` });
    // The prebuilt binary is used rather than `cargo run` so the wait budget is
    // spent on startup, not on a cold compile.
    start(`${MONOREPO}/services/risk-compliance-core/target/debug/risk-compliance-core`, [], `${MONOREPO}/services/risk-compliance-core`, { PORT: "18182" });
    start("python3", ["-m", "uvicorn", "umojaflowos_reporting.service:app", "--port", "18184"], `${MONOREPO}/services/reporting-analytics`, { PYTHONPATH: "src" });

    await Promise.all([
      waitForPort("http://127.0.0.1:18181/healthz"),
      waitForPort("http://127.0.0.1:18182/healthz", 180),
      waitForPort("http://127.0.0.1:18184/healthz"),
    ]);
  }, 300_000);

  afterAll(() => {
    for (const child of processes) child.kill("SIGTERM");
  });

  it("reads real metrics from the Go payment engine", async () => {
    const status = await collectServiceStatus("payment-engine", {
      env: { UMOJA_PAYMENT_ENGINE_URL: "http://127.0.0.1:18181" },
    });
    expect(status.status).toBe("healthy");
    if (status.status !== "healthy") return;
    expect(status.language).toBe("go");
    // The counter names are part of the contract between the service and the
    // dashboard; renaming one must fail here.
    expect(status.counters).toHaveProperty("validations_total");
    expect(status.posture.provider_execution).toBe("disabled_without_verified_provider");
  });

  it("reads real metrics from the Rust risk core", async () => {
    const status = await collectServiceStatus("risk-compliance-core", {
      env: { UMOJA_RISK_CORE_URL: "http://127.0.0.1:18182" },
    });
    expect(status.status).toBe("healthy");
    if (status.status !== "healthy") return;
    expect(status.language).toBe("rust");
    expect(status.counters).toHaveProperty("monitoring_evaluations");
  });

  it("reads real metrics from the Python reporting service", async () => {
    const status = await collectServiceStatus("reporting-analytics", {
      env: { UMOJA_REPORTING_URL: "http://127.0.0.1:18184" },
    });
    expect(status.status).toBe("healthy");
    if (status.status !== "healthy") return;
    expect(status.language).toBe("python");
    expect(status.counters).toHaveProperty("requests_total");
    expect(status.posture.regulatory_submission).toBe("disabled_without_verified_channel");
  });

  it("observes a counter increase after real traffic", async () => {
    // This is what separates a metrics endpoint from a constant: the number has
    // to move when the service does work.
    const before = await collectServiceStatus("reporting-analytics", {
      env: { UMOJA_REPORTING_URL: "http://127.0.0.1:18184" },
    });
    await fetch("http://127.0.0.1:18184/healthz");
    const after = await collectServiceStatus("reporting-analytics", {
      env: { UMOJA_REPORTING_URL: "http://127.0.0.1:18184" },
    });
    if (before.status !== "healthy" || after.status !== "healthy") throw new Error("service not healthy");
    expect(after.counters.requests_total).toBeGreaterThan(before.counters.requests_total);
  });
});
