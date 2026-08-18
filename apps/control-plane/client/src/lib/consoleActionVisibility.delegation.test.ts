import { describe, expect, it } from "vitest";

import { canOpenConsoleComposer, visibleConsoleModuleActions } from "./consoleActionVisibility";

/**
 * These checks encode the approved administrator delegation matrix at the
 * visibility layer, so the interface and the server gates cannot drift apart.
 */
describe("administrator delegation in the console", () => {
  it("excludes administrators from SAR/STR filing while compliance officers retain it", () => {
    expect(canOpenConsoleComposer("compliance_officer", "sar-str")).toBe(true);
    expect(canOpenConsoleComposer("admin", "sar-str")).toBe(false);
    expect(canOpenConsoleComposer("treasury_operator", "sar-str")).toBe(false);
    expect(canOpenConsoleComposer("auditor", "sar-str")).toBe(false);
    expect(canOpenConsoleComposer(undefined, "sar-str")).toBe(false);
  });

  it("shows an administrator the compliance module without the SAR/STR action", () => {
    const adminActions = visibleConsoleModuleActions("admin", "compliance");
    expect(adminActions).toContain("New case");
    expect(adminActions).toContain("KYC evidence");
    expect(adminActions).not.toContain("SAR/STR");

    const officerActions = visibleConsoleModuleActions("compliance_officer", "compliance");
    expect(officerActions).toContain("SAR/STR");
  });

  it("retains delegated administrator access across the other approved domains", () => {
    // Delegation exists so an administrator can restore service; it is bounded
    // by the two documented exclusions rather than removed wholesale.
    expect(visibleConsoleModuleActions("admin", "treasury")).toContain("New position");
    expect(visibleConsoleModuleActions("admin", "markets")).toEqual(["Observe", "Lock"]);
    expect(visibleConsoleModuleActions("admin", "payments")).toEqual(["Draft", "Leg"]);
    expect(visibleConsoleModuleActions("admin", "reports")).toEqual(["Report", "Deadline"]);
  });

  it("keeps licence authorisation administrator-only", () => {
    expect(canOpenConsoleComposer("admin", "authorization")).toBe(true);
    for (const role of ["compliance_officer", "treasury_operator", "auditor"] as const) {
      expect(canOpenConsoleComposer(role, "authorization")).toBe(false);
    }
  });

  it("grants an auditor no composer anywhere", () => {
    for (const module of ["registry", "integrations", "governance", "treasury", "markets", "payments", "compliance", "reports", "alerts"] as const) {
      expect(visibleConsoleModuleActions("auditor", module)).toEqual([]);
    }
  });
});
