import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ServiceStatusDashboard, type ServiceStatusRow } from "./ServiceStatusDashboard";

/**
 * The dashboard's only job is to be truthful under pressure. These tests target
 * the ways a status panel typically lies: rendering a disabled service as
 * broken, rendering a broken service as fine, showing a number nobody reported,
 * and showing a stale reading as if it were current.
 */
const healthy: ServiceStatusRow = {
  service: "payment-engine",
  language: "go",
  status: "healthy",
  latencyMs: 12,
  uptimeSeconds: 3_725,
  observedAt: "2026-08-19T02:00:00Z",
  counters: { validations_total: 41, validations_invalid: 3, uptime_seconds: 3_725 },
  posture: { provider_execution: "disabled_without_verified_provider" },
};

describe("service status dashboard", () => {
  // Without this, renders accumulate in the same document and assertions start
  // matching elements from earlier tests.
  afterEach(cleanup);

  it("renders reported counters with their values", () => {
    render(<ServiceStatusDashboard data={[healthy]} loading={false} isFetching={false} onRefresh={vi.fn()} />);
    expect(screen.getByText("41")).toBeTruthy();
    expect(screen.getByText("validations invalid")).toBeTruthy();
    expect(screen.getByText("3")).toBeTruthy();
    // Uptime is formatted, not shown as a raw second count.
    expect(screen.getByText("1h 2m")).toBeTruthy();
  });

  it("does not display a counter the service never reported", () => {
    const sparse: ServiceStatusRow = { ...healthy, counters: { uptime_seconds: 10 }, uptimeSeconds: 10 };
    render(<ServiceStatusDashboard data={[sparse]} loading={false} isFetching={false} onRefresh={vi.fn()} />);
    // An invented zero would read as "no validations are happening", which is a
    // different and possibly alarming claim.
    const card = screen.getByTestId("service-status-payment-engine");
    expect(within(card).queryByText("validations total")).toBeNull();
    expect(within(card).queryByText("validations invalid")).toBeNull();
  });

  it("distinguishes a disabled service from a failing one", () => {
    const rows: ServiceStatusRow[] = [
      { service: "ledger-gateway", language: "rust", status: "not_configured", reason: "no endpoint is configured for this service, so it is disabled" },
      { service: "risk-compliance-core", language: "rust", status: "unreachable", reason: "service did not respond within 3000ms", latencyMs: 3_000 },
    ];
    render(<ServiceStatusDashboard data={rows} loading={false} isFetching={false} onRefresh={vi.fn()} />);
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByText("Not responding")).toBeTruthy();
    // The reason is always shown; "not responding" alone is not actionable.
    expect(screen.getByText(/did not respond within 3000ms/)).toBeTruthy();
  });

  it("never labels an unreachable service as responding", () => {
    const rows: ServiceStatusRow[] = [
      { service: "risk-compliance-core", language: "rust", status: "unreachable", reason: "service returned HTTP 503", latencyMs: 8 },
    ];
    render(<ServiceStatusDashboard data={rows} loading={false} isFetching={false} onRefresh={vi.fn()} />);
    expect(screen.queryByText("Responding")).toBeNull();
  });

  it("separates a collection failure from a service failure", () => {
    render(<ServiceStatusDashboard data={undefined} loading={false} isFetching={false} error="FORBIDDEN" onRefresh={vi.fn()} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("FORBIDDEN");
    // Saying the services are down when we simply could not look would send an
    // operator chasing the wrong problem.
    expect(alert.textContent).toMatch(/not that the services are unhealthy/);
  });

  it("shows when the reading was taken so a stale panel is visibly stale", () => {
    render(
      <ServiceStatusDashboard data={[healthy]} loading={false} isFetching={false} observedAt="2026-08-19T02:00:00Z" onRefresh={vi.fn()} />,
    );
    expect(screen.getByTestId("service-status-observed").textContent).toMatch(/Collected/);
  });

  it("surfaces the provider posture reported by the service", () => {
    render(<ServiceStatusDashboard data={[healthy]} loading={false} isFetching={false} onRefresh={vi.fn()} />);
    expect(screen.getByText(/disabled without verified provider/)).toBeTruthy();
  });

  it("refreshes on demand", async () => {
    const onRefresh = vi.fn();
    render(<ServiceStatusDashboard data={[healthy]} loading={false} isFetching={false} onRefresh={onRefresh} />);
    await userEvent.click(screen.getByRole("button", { name: /refresh now/i }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it("distinguishes loading from empty", () => {
    render(<ServiceStatusDashboard data={undefined} loading isFetching onRefresh={vi.fn()} />);
    expect(screen.getByTestId("service-status-loading")).toBeTruthy();
  });
});
