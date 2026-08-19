import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/const", () => ({ startLogin: vi.fn() }));

import StakeholderOnboarding from "./StakeholderOnboarding";

describe("public stakeholder onboarding", () => {
  afterEach(cleanup);

  it("renders the six-workspace introduction before operational access without exposing authority", () => {
    render(<StakeholderOnboarding />);
    expect(screen.getByRole("heading", { name: /start with your operating role/i })).toBeTruthy();
    expect(screen.getByText(/Six role-specific workspaces/i)).toBeTruthy();
    expect(screen.getByText(/does not expose records, impersonate a stakeholder/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /access assigned workspace/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /activate provider/i })).toBeNull();
  });
});
