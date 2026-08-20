import { cleanup, render, screen } from "@testing-library/react";
import axe from "axe-core";
import { afterEach, describe, expect, it } from "vitest";
import PublicLanding from "./PublicLanding";

describe("PublicLanding", () => {
  afterEach(cleanup);

  it("explains the platform in stakeholder language without claiming unactivated execution", () => {
    render(<PublicLanding />);
    expect(screen.getByRole("heading", { name: /keep every accountable party/i })).toBeTruthy();
    expect(screen.getByText(/does not replace your bank/i)).toBeTruthy();
    expect(screen.getByText(/Nigeria \(NGN\)/i)).toBeTruthy();
    expect(screen.getByText(/Kenya \(KES\)/i)).toBeTruthy();
    expect(screen.getByText(/South Africa \(ZAR\)/i)).toBeTruthy();
    expect(screen.getByText(/activate nothing by default/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /partner readiness begins with evidence/i })).toBeTruthy();
    expect(screen.getByText(/a request is not an activation/i)).toBeTruthy();
    expect(screen.getByRole("heading", { name: /a clear next step for every role/i })).toBeTruthy();
    expect(screen.getByRole("heading", { name: /your role should define what you can see and do/i })).toBeTruthy();
    expect(screen.getByText(/high-impact actions stay closed/i)).toBeTruthy();
  });

  it("offers pre-auth onboarding and sign-in paths", () => {
    render(<PublicLanding />);
    expect(screen.getAllByRole("button", { name: /start onboarding|find your role|begin stakeholder onboarding/i }).length).toBeGreaterThan(0);
    expect(screen.getAllByRole("button", { name: /sign in/i }).length).toBeGreaterThan(0);
  });

  it("keeps the stakeholder and partner entry page accessible", async () => {
    render(<PublicLanding />);
    const results = await axe.run(document.body, {
      rules: { "color-contrast": { enabled: false } },
      resultTypes: ["violations"],
    });
    expect(results.violations.map(violation => `${violation.id}: ${violation.help}`)).toEqual([]);
  });
});
