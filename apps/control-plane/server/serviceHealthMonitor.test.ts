import { describe, expect, it, vi } from "vitest";
import { healthMonitorConfiguration, runServiceHealthMonitorRound, startServiceHealthMonitor } from "./serviceHealthMonitor";

describe("service health monitor", () => {
  it("is disabled unless explicitly enabled and rejects unsafe intervals", () => {
    expect(startServiceHealthMonitor({})).toBeNull();
    expect(healthMonitorConfiguration.strictEnabled(undefined)).toBe(false);
    expect(() => healthMonitorConfiguration.strictEnabled("yes")).toThrow(/true or false/);
    expect(healthMonitorConfiguration.configuredInterval("60")).toBe(60);
    expect(() => healthMonitorConfiguration.configuredInterval("59")).toThrow(/between/);
    expect(() => healthMonitorConfiguration.configuredInterval("five")).toThrow(/integer/);
  });

  it("records one round only when this replica becomes leader", async () => {
    const release = vi.fn(async () => undefined);
    const collect = vi.fn(async () => ({
      observedAt: "2026-08-25T12:00:00.000Z",
      services: [{ service: "payment-engine", language: "go", status: "healthy" as const, latencyMs: 8, uptimeSeconds: 10, counters: {}, posture: {}, observedAt: "2026-08-25T12:00:00.000Z" }],
    }));
    const record = vi.fn(async () => 1);
    const result = await runServiceHealthMonitorRound({ acquireLeader: async () => release, collect: collect as never, record: record as never, now: () => new Date("2026-08-25T12:00:01.000Z") });
    expect(result).toEqual({ status: "collected", written: 1, observedAt: "2026-08-25T12:00:00.000Z" });
    expect(record).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("does not record duplicate samples when another replica holds the leader lock", async () => {
    const collect = vi.fn();
    const result = await runServiceHealthMonitorRound({ acquireLeader: async () => null, collect: collect as never, record: vi.fn() as never, now: () => new Date() });
    expect(result).toEqual({ status: "leader_unavailable", written: 0 });
    expect(collect).not.toHaveBeenCalled();
  });

  it("records monitor failures as a non-throwing result and always releases the lock", async () => {
    const release = vi.fn(async () => undefined);
    const result = await runServiceHealthMonitorRound({ acquireLeader: async () => release, collect: async () => { throw new Error("risk core unavailable"); }, record: vi.fn() as never, now: () => new Date() });
    expect(result).toEqual({ status: "failed", written: 0, reason: "risk core unavailable" });
    expect(release).toHaveBeenCalledTimes(1);
  });
});
