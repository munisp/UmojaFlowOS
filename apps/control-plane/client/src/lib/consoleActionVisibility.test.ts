import { describe, expect, it } from "vitest";
import { visibleConsoleModuleActions } from "./consoleActionVisibility";

describe("Home console rendered-action visibility", () => {
  it("keeps auditors read-only in every operator module", () => {
    for (const module of ["registry", "integrations", "governance", "treasury", "markets", "payments", "compliance", "reports", "alerts"] as const) {
      expect(visibleConsoleModuleActions("auditor", module)).toEqual([]);
    }
  });

  it("shows only treasury actions to treasury operators", () => {
    expect(visibleConsoleModuleActions("treasury_operator", "treasury")).toEqual(["New position"]);
    expect(visibleConsoleModuleActions("treasury_operator", "markets")).toEqual(["Observe", "Lock"]);
    expect(visibleConsoleModuleActions("treasury_operator", "payments")).toEqual(["Draft", "Leg"]);
    expect(visibleConsoleModuleActions("treasury_operator", "compliance")).toEqual([]);
    expect(visibleConsoleModuleActions("treasury_operator", "reports")).toEqual([]);
  });

  it("shows only compliance actions to compliance officers", () => {
    expect(visibleConsoleModuleActions("compliance_officer", "compliance")).toEqual(["New case", "KYC evidence", "Consent", "Analyse", "SAR/STR"]);
    expect(visibleConsoleModuleActions("compliance_officer", "governance")).toEqual(["New policy"]);
    expect(visibleConsoleModuleActions("compliance_officer", "reports")).toEqual(["Report", "Deadline"]);
    expect(visibleConsoleModuleActions("compliance_officer", "treasury")).toEqual([]);
    expect(visibleConsoleModuleActions("compliance_officer", "alerts")).toEqual([]);
  });

  it("delegates every displayed action to administrators", () => {
    expect(visibleConsoleModuleActions("admin", "registry")).toEqual(["Record", "Licence"]);
    expect(visibleConsoleModuleActions("admin", "alerts")).toEqual(["Policy", "Evaluate"]);
  });
});
