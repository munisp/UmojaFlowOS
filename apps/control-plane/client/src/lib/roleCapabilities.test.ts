import { describe, expect, it } from "vitest";
import { canPerformConsoleAction } from "./roleCapabilities";

describe("UmojaFlowOS console role capabilities", () => {
  it("keeps auditor identities read-only", () => {
    expect(canPerformConsoleAction("auditor", "payment")).toBe(false);
    expect(canPerformConsoleAction("auditor", "deadline")).toBe(false);
  });

  it("assigns treasury controls without compliance or admin controls", () => {
    expect(canPerformConsoleAction("treasury_operator", "rate-lock")).toBe(true);
    expect(canPerformConsoleAction("treasury_operator", "payment-leg")).toBe(true);
    expect(canPerformConsoleAction("treasury_operator", "deadline")).toBe(false);
    expect(canPerformConsoleAction("treasury_operator", "evaluate-deadlines")).toBe(false);
  });

  it("assigns compliance deadline controls without reminder evaluation", () => {
    expect(canPerformConsoleAction("compliance_officer", "deadline")).toBe(true);
    expect(canPerformConsoleAction("compliance_officer", "evaluate-deadlines")).toBe(false);
  });

  it("assigns all controls to administrators", () => {
    expect(canPerformConsoleAction("admin", "evaluate-deadlines")).toBe(true);
    expect(canPerformConsoleAction("admin", "counterparty")).toBe(true);
  });
});
