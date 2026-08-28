import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LegalEntityRegistrationForm } from "./LegalEntityRegistrationForm";

describe("legal entity registration form", () => {
  afterEach(() => cleanup());

  it("explains that registration creates no regulatory authority", () => {
    render(<LegalEntityRegistrationForm pending={false} submit={vi.fn()} />);
    expect(screen.getByText(/creates no counterparty authorization, licence evidence, or regulatory submission/i)).toBeTruthy();
  });

  it("submits trimmed legal identity fields", () => {
    const submit = vi.fn();
    render(<LegalEntityRegistrationForm pending={false} submit={submit} />);
    const form = screen.getByRole("button", { name: /Register legal entity/i }).closest("form") as HTMLFormElement;
    fireEvent.change(form.querySelector('[name="legalName"]') as HTMLInputElement, { target: { value: "  Umoja Holdings Limited  " } });
    fireEvent.change(form.querySelector('[name="jurisdiction"]') as HTMLSelectElement, { target: { value: "Kenya" } });
    fireEvent.change(form.querySelector('[name="registrationIdentifier"]') as HTMLInputElement, { target: { value: "  REG-001  " } });
    fireEvent.submit(form);
    expect(submit).toHaveBeenCalledWith({ legalName: "Umoja Holdings Limited", jurisdiction: "Kenya", registrationIdentifier: "REG-001" });
  });

  it("requires legal name, jurisdiction, and registration identifier", () => {
    render(<LegalEntityRegistrationForm pending={false} submit={vi.fn()} />);
    const form = screen.getByRole("button", { name: /Register legal entity/i }).closest("form") as HTMLFormElement;
    for (const name of ["legalName", "jurisdiction", "registrationIdentifier"]) {
      expect((form.querySelector(`[name="${name}"]`) as HTMLInputElement).required).toBe(true);
    }
  });

  it("disables submission while registration is pending", () => {
    render(<LegalEntityRegistrationForm pending submit={vi.fn()} />);
    expect((screen.getByRole("button", { name: /Registering/i }) as HTMLButtonElement).disabled).toBe(true);
  });
});
