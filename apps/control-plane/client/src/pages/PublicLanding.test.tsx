import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import PublicLanding from "./PublicLanding";

describe("PublicLanding", () => {
  it("explains the platform in stakeholder language without claiming unactivated execution", () => {
    render(<PublicLanding />);
    expect(screen.getByRole("heading", { name: /keep every accountable party/i })).toBeTruthy();
    expect(screen.getByText(/does not replace your bank/i)).toBeTruthy();
    expect(screen.getByText(/Nigeria \(NGN\)/i)).toBeTruthy();
    expect(screen.getByText(/Kenya \(KES\)/i)).toBeTruthy();
    expect(screen.getByText(/South Africa \(ZAR\)/i)).toBeTruthy();
    expect(screen.getByText(/activate nothing by default/i)).toBeTruthy();
  });

  it("offers pre-auth onboarding and sign-in paths", () => {
    render(<PublicLanding />);
    expect(screen.getAllByRole("button", { name: /start onboarding|find your role|begin stakeholder onboarding/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /sign in/i }).length).toBeGreaterThan(0);
  });
});
