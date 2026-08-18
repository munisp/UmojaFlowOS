import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConsoleModuleActions } from "./ConsoleModuleActions";
import { consoleModuleActions, type ConsoleModule } from "@/lib/consoleActionVisibility";
import type { OperatorRole } from "@/lib/roleCapabilities";

const modules = Object.keys(consoleModuleActions) as ConsoleModule[];

function visibleLabels(role: OperatorRole | undefined, module: ConsoleModule): string[] {
  cleanup();
  render(<ConsoleModuleActions role={role} module={module} onOpen={() => undefined} />);
  return screen.queryAllByRole("button").map(button => button.textContent?.trim() ?? "");
}

describe("console module action visibility by role", () => {
  afterEach(() => cleanup());

  it("renders no privileged action for an auditor in any module", () => {
    for (const module of modules) {
      expect(visibleLabels("auditor", module)).toEqual([]);
    }
  });

  it("renders no privileged action for an unauthenticated visitor in any module", () => {
    for (const module of modules) {
      expect(visibleLabels(undefined, module)).toEqual([]);
    }
  });

  it("renders exactly the compliance actions a compliance officer may open", () => {
    expect(visibleLabels("compliance_officer", "compliance")).toEqual(["New case", "KYC evidence", "Consent", "Analyse", "SAR/STR"]);
    expect(visibleLabels("compliance_officer", "reports")).toEqual(["Report", "Deadline"]);
    expect(visibleLabels("compliance_officer", "governance")).toEqual(["New policy"]);
    expect(visibleLabels("compliance_officer", "treasury")).toEqual([]);
    expect(visibleLabels("compliance_officer", "markets")).toEqual([]);
    expect(visibleLabels("compliance_officer", "registry")).toEqual([]);
    expect(visibleLabels("compliance_officer", "alerts")).toEqual([]);
  });

  it("renders exactly the treasury actions a treasury operator may open", () => {
    expect(visibleLabels("treasury_operator", "treasury")).toEqual(["New position"]);
    expect(visibleLabels("treasury_operator", "markets")).toEqual(["Observe", "Lock"]);
    expect(visibleLabels("treasury_operator", "payments")).toEqual(["Draft", "Leg"]);
    expect(visibleLabels("treasury_operator", "compliance")).toEqual([]);
    expect(visibleLabels("treasury_operator", "reports")).toEqual([]);
    expect(visibleLabels("treasury_operator", "registry")).toEqual([]);
    expect(visibleLabels("treasury_operator", "alerts")).toEqual([]);
  });

  it("renders the delegated administrator surface including licence and reminder controls", () => {
    expect(visibleLabels("admin", "registry")).toEqual(["Record", "Licence"]);
    expect(visibleLabels("admin", "alerts")).toEqual(["Policy", "Evaluate"]);
    expect(visibleLabels("admin", "treasury")).toEqual(["New position"]);
    // Administrator delegation stops at SAR/STR: a suspicious-activity report
    // is a personal attestation by the compliance officer who formed it.
    expect(visibleLabels("admin", "compliance")).toEqual(["New case", "KYC evidence"]);
  });

  it("keeps a rendered action disabled when its workflow is gated rather than hiding the state", () => {
    const onOpen = vi.fn();
    render(<ConsoleModuleActions role="admin" module="alerts" disabledActions={["evaluate-deadlines"]} onOpen={onOpen} />);
    const evaluate = screen.getAllByRole("button").find(button => button.textContent?.includes("Evaluate")) as HTMLButtonElement;
    expect(evaluate.disabled).toBe(true);
    evaluate.click();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("invokes the composer only for an action the role may open", () => {
    const onOpen = vi.fn();
    render(<ConsoleModuleActions role="compliance_officer" module="compliance" onOpen={onOpen} />);
    (screen.getAllByRole("button")[0] as HTMLButtonElement).click();
    expect(onOpen).toHaveBeenCalledWith("case");
  });
});
