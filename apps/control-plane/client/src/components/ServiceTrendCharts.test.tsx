import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildLatencySeries,
  buildThroughputSeries,
  ServiceTrendCharts,
  type AvailabilityRow,
  type TrendSample,
} from "./ServiceTrendCharts";

afterEach(cleanup);

// Recharts' responsive container observes element size, which jsdom does not
// implement. Supplying a real observer object (rather than stubbing the chart)
// keeps the component under test the same component that ships.
class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = TestResizeObserver;

const at = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);

describe("trend series construction", () => {
  it("represents an unreachable observation as a gap rather than as zero latency", () => {
    const samples: TrendSample[] = [
      { service: "risk-compliance-core", status: "healthy", latencyMs: 15, counters: {}, collectedAt: at(3) },
      { service: "risk-compliance-core", status: "unreachable", latencyMs: null, counters: {}, collectedAt: at(2) },
      { service: "risk-compliance-core", status: "healthy", latencyMs: 18, counters: {}, collectedAt: at(1) },
    ];
    const series = buildLatencySeries(samples);
    expect(series.map(row => row["risk-compliance-core"])).toEqual([15, null, 18]);
    // The middle point is null, not 0. Zero would plot as the fastest response
    // in the window when in fact nothing responded.
    expect(series[1]["risk-compliance-core"]).not.toBe(0);
  });

  it("aligns two services collected at the same moment onto one row", () => {
    const moment = at(5);
    const series = buildLatencySeries([
      { service: "risk-compliance-core", status: "healthy", latencyMs: 10, counters: {}, collectedAt: moment },
      { service: "payment-engine", status: "healthy", latencyMs: 20, counters: {}, collectedAt: moment },
    ]);
    expect(series).toHaveLength(1);
    expect(series[0]["risk-compliance-core"]).toBe(10);
    expect(series[0]["payment-engine"]).toBe(20);
  });

  it("plots throughput as the change between observations, not the cumulative total", () => {
    const rows = buildThroughputSeries(
      [
        { service: "payment-engine", status: "healthy", latencyMs: 5, counters: { orders_validated: 100 }, collectedAt: at(3) },
        { service: "payment-engine", status: "healthy", latencyMs: 5, counters: { orders_validated: 112 }, collectedAt: at(2) },
        { service: "payment-engine", status: "healthy", latencyMs: 5, counters: { orders_validated: 115 }, collectedAt: at(1) },
      ],
      "orders_validated",
    );
    // First observation establishes a baseline and yields no bar.
    expect(rows.map(row => row["payment-engine"])).toEqual([12, 3]);
  });

  it("drops the interval spanning a counter reset rather than drawing negative throughput", () => {
    const rows = buildThroughputSeries(
      [
        { service: "risk-compliance-core", status: "healthy", latencyMs: 5, counters: { evaluations: 500 }, collectedAt: at(3) },
        // Service restarted; the counter went backwards.
        { service: "risk-compliance-core", status: "healthy", latencyMs: 5, counters: { evaluations: 4 }, collectedAt: at(2) },
        { service: "risk-compliance-core", status: "healthy", latencyMs: 5, counters: { evaluations: 9 }, collectedAt: at(1) },
      ],
      "evaluations",
    );
    expect(rows.map(row => row["risk-compliance-core"])).toEqual([5]);
    expect(rows.every(row => Number(row["risk-compliance-core"]) >= 0)).toBe(true);
  });
});

describe("service trend charts", () => {
  const availability: AvailabilityRow[] = [
    {
      service: "payment-engine",
      language: "go",
      samples: 4,
      healthySamples: 3,
      availability: 0.75,
      medianLatencyMs: 14,
      lastStatus: "unreachable",
      lastCollectedAt: at(1),
    },
  ];

  it("distinguishes loading from an empty history and explains why no trend exists", () => {
    render(<ServiceTrendCharts samples={[]} availability={[]} loading windowMinutes={60} onWindowChange={() => {}} />);
    expect(screen.getByTestId("trend-loading")).toBeTruthy();
    cleanup();

    render(<ServiceTrendCharts samples={[]} availability={[]} loading={false} windowMinutes={60} onWindowChange={() => {}} />);
    const empty = screen.getByTestId("trend-empty").textContent ?? "";
    expect(empty).toContain("No health observations have been recorded");
    // It states why rather than showing an empty chart frame.
    expect(empty).toContain("one reading is not a trend");
  });

  it("reports availability as observed, including the most recent state rather than the best", () => {
    render(
      <ServiceTrendCharts
        samples={[{ service: "payment-engine", status: "healthy", latencyMs: 14, counters: {}, collectedAt: at(2) }]}
        availability={availability}
        loading={false}
        windowMinutes={60}
        onWindowChange={() => {}}
      />,
    );
    const table = screen.getByTestId("availability-table").textContent ?? "";
    expect(table).toContain("75.0%");
    expect(table).toContain("3/4");
    expect(table).toContain("14 ms");
    // The last observation was a failure and is shown as such.
    expect(table).toContain("Not responding");
  });

  it("states that availability is unknown rather than perfect when nothing was observed", () => {
    render(
      <ServiceTrendCharts
        samples={[{ service: "risk-compliance-core", status: "unreachable", latencyMs: null, counters: {}, collectedAt: at(2) }]}
        availability={[]}
        loading={false}
        windowMinutes={60}
        onWindowChange={() => {}}
      />,
    );
    const text = screen.getByTestId("availability-empty").textContent ?? "";
    expect(text).toContain("No availability can be stated");
    expect(text).not.toContain("100");
  });

  it("lets the operator change the window and toggle a series", () => {
    const onWindowChange = vi.fn();
    render(
      <ServiceTrendCharts
        samples={[
          { service: "payment-engine", status: "healthy", latencyMs: 14, counters: {}, collectedAt: at(2) },
          { service: "risk-compliance-core", status: "healthy", latencyMs: 9, counters: {}, collectedAt: at(2) },
        ]}
        availability={availability}
        loading={false}
        windowMinutes={60}
        onWindowChange={onWindowChange}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Last 24 hours" }));
    expect(onWindowChange).toHaveBeenCalledWith(1440);

    const toggle = screen.getByRole("button", { name: /Payment engine/ });
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(screen.getByRole("button", { name: /Payment engine/ }).getAttribute("aria-pressed")).toBe("false");
  });

  it("marks the active window so the operator knows what period is displayed", () => {
    render(
      <ServiceTrendCharts
        samples={[{ service: "risk-compliance-core", status: "healthy", latencyMs: 9, counters: {}, collectedAt: at(2) }]}
        availability={availability}
        loading={false}
        windowMinutes={1440}
        onWindowChange={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Last 24 hours" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Last hour" }).getAttribute("aria-pressed")).toBe("false");
  });
});
