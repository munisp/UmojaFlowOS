import { describe, expect, it, vi } from "vitest";

vi.mock("./serviceHealthHistory", () => ({
  summariseServiceAvailability: vi.fn(),
}));

import { summariseServiceAvailability } from "./serviceHealthHistory";
import { evaluateServiceHealthSlo, serviceHealthSloValidation } from "./serviceHealthSlo";

const summary = (availability: number | null, samples: number) => ({
  service: "payment-engine",
  language: "go",
  samples,
  healthySamples: availability === null ? 0 : Math.round(samples * availability),
  availability,
  medianLatencyMs: 15,
  lastStatus: "healthy",
  lastCollectedAt: new Date("2026-08-25T12:00:00.000Z"),
});

describe("service health SLO evaluator", () => {
  it("reports insufficient evidence rather than a passing SLO for sparse or missing samples", async () => {
    vi.mocked(summariseServiceAvailability).mockResolvedValue([summary(null, 0)]);
    const [result] = await evaluateServiceHealthSlo({ minimumSamples: 10 });
    expect(result.status).toBe("insufficient_evidence");
    expect(result.observedAvailability).toBeNull();
    expect(result.reason).toContain("at least 10");
  });

  it("reports an observed breach without smoothing the availability", async () => {
    vi.mocked(summariseServiceAvailability).mockResolvedValue([summary(0.99, 300)]);
    const [result] = await evaluateServiceHealthSlo({ targetAvailability: 0.995, minimumSamples: 288 });
    expect(result.status).toBe("breach");
    expect(result.observedAvailability).toBe(0.99);
    expect(result.reason).toContain("below target");
  });

  it("reports a measured target only when enough samples support it", async () => {
    vi.mocked(summariseServiceAvailability).mockResolvedValue([summary(0.997, 288)]);
    const [result] = await evaluateServiceHealthSlo({ minimumSamples: 288 });
    expect(result.status).toBe("within_target");
  });

  it("rejects unsafe evaluator inputs", () => {
    expect(() => serviceHealthSloValidation.boundedRatio(0.89, 0.995)).toThrow(/between/);
    expect(() => serviceHealthSloValidation.boundedInteger(0, 60, 1, 20)).toThrow(/between/);
  });
});
