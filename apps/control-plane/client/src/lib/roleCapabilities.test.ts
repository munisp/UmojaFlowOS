import { describe, expect, it } from "vitest";
import { canPerformConsoleAction, type ConsoleAction, type OperatorRole } from "./roleCapabilities";

describe("UmojaFlowOS console role capabilities", () => {
  it("keeps auditor identities read-only", () => {
    expect(canPerformConsoleAction("auditor", "payment")).toBe(false);
    expect(canPerformConsoleAction("auditor", "deadline")).toBe(false);
    expect(canPerformConsoleAction("auditor", "rate-lock")).toBe(false);
    expect(canPerformConsoleAction("auditor", "payment-leg")).toBe(false);
    expect(canPerformConsoleAction("auditor", "report")).toBe(false);
    expect(canPerformConsoleAction("auditor", "sar-str")).toBe(false);
    expect(canPerformConsoleAction("auditor", "kyc-document")).toBe(false);
  });

  it("assigns treasury controls without compliance or admin controls", () => {
    expect(canPerformConsoleAction("treasury_operator", "rate-lock")).toBe(true);
    expect(canPerformConsoleAction("treasury_operator", "payment-leg")).toBe(true);
    expect(canPerformConsoleAction("treasury_operator", "deadline")).toBe(false);
    expect(canPerformConsoleAction("treasury_operator", "sar-str")).toBe(false);
    expect(canPerformConsoleAction("treasury_operator", "kyc-document")).toBe(false);
    expect(canPerformConsoleAction("treasury_operator", "evaluate-deadlines")).toBe(false);
  });

  it("assigns compliance deadline controls without reminder evaluation", () => {
    expect(canPerformConsoleAction("compliance_officer", "deadline")).toBe(true);
    expect(canPerformConsoleAction("compliance_officer", "report")).toBe(true);
    expect(canPerformConsoleAction("compliance_officer", "sar-str")).toBe(true);
    expect(canPerformConsoleAction("compliance_officer", "kyc-document")).toBe(true);
    expect(canPerformConsoleAction("compliance_officer", "rate-lock")).toBe(false);
    expect(canPerformConsoleAction("compliance_officer", "payment-leg")).toBe(false);
    expect(canPerformConsoleAction("compliance_officer", "evaluate-deadlines")).toBe(false);
  });

  it("assigns all controls to administrators", () => {
    expect(canPerformConsoleAction("admin", "evaluate-deadlines")).toBe(true);
    expect(canPerformConsoleAction("admin", "counterparty")).toBe(true);
    expect(canPerformConsoleAction("admin", "sar-str")).toBe(true);
    expect(canPerformConsoleAction("admin", "kyc-document")).toBe(true);
  });

  it("enforces an exhaustive role-action visibility matrix", () => {
    const actions: ConsoleAction[] = ["counterparty", "integration", "alert", "policy", "case", "kyc-document", "sar-str", "report", "deadline", "customer", "beneficiary", "liquidity", "market", "rate-lock", "payment", "payment-leg", "evaluate-deadlines"];
    const expected: Record<OperatorRole, ConsoleAction[]> = {
      admin: actions,
      compliance_officer: ["policy", "case", "kyc-document", "sar-str", "report", "deadline"],
      treasury_operator: ["customer", "beneficiary", "liquidity", "market", "rate-lock", "payment", "payment-leg"],
      auditor: [],
    };

    for (const [role, permitted] of Object.entries(expected) as [OperatorRole, ConsoleAction[]][]) {
      for (const action of actions) expect(canPerformConsoleAction(role, action)).toBe(permitted.includes(action));
    }
  });
});
