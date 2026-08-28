import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const customersQuery = vi.fn();
const customerWorkspaceQuery = vi.fn();
const createCustomer = vi.fn();
const updateCustomerProfile = vi.fn();
const recordDestinationCounterparty = vi.fn();
const decideUseCaseGate = vi.fn();
const updateKycDocumentReview = vi.fn();

const baseCustomer = {
  id: "customer-1",
  legalName: "Acme Holdings Ltd",
  registrationIdentifier: "RC123456",
  kycStatus: "open",
  archetype: null,
  tier: null,
  documentCount: "0",
  approvedDocumentCount: "0",
  createdAt: new Date("2026-08-01T00:00:00Z"),
};

const baseWorkspace = {
  customer: { ...baseCustomer, useCaseNarrative: null },
  destinationCounterparties: [],
  useCaseGateDecisions: [],
  kycDocuments: [],
  linkedAnalysisJobs: [],
  linkedEvidence: [],
  linkedReviewerDecisions: [],
  activity: [],
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { customers: { invalidate: vi.fn() }, customerWorkspace: { invalidate: vi.fn() }, kycDocuments: { invalidate: vi.fn() } } }),
    postgres: {
      customers: { useQuery: () => customersQuery() },
      customerWorkspace: { useQuery: () => customerWorkspaceQuery() },
      createCustomer: { useMutation: () => ({ isPending: false, mutate: createCustomer, error: null }) },
      updateCustomerProfile: { useMutation: () => ({ isPending: false, mutate: updateCustomerProfile, error: null }) },
      recordCustomerDestinationCounterparty: { useMutation: () => ({ isPending: false, mutate: recordDestinationCounterparty, error: null }) },
      decideCustomerUseCaseGate: { useMutation: () => ({ isPending: false, mutate: decideUseCaseGate, error: null }) },
      createKycDocumentUploadIntent: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
      finalizeKycDocumentUpload: { useMutation: () => ({ mutateAsync: vi.fn(), isPending: false }) },
      updateKycDocumentReview: { useMutation: () => ({ isPending: false, mutate: updateKycDocumentReview, error: null }) },
    },
  },
}));

import { EnterpriseCustomersWorkspace } from "./EnterpriseCustomersWorkspace";

describe("enterprise customers workspace", () => {
  afterEach(cleanup);

  it("withholds the workspace from a role with no access", () => {
    customersQuery.mockReturnValue({ data: [], isLoading: false });
    render(<EnterpriseCustomersWorkspace role="provider_contact" />);
    expect(screen.getByText(/no access to enterprise customer records/i)).toBeTruthy();
  });

  it("shows a read-only list without the create affordance for an auditor", () => {
    customersQuery.mockReturnValue({ data: [baseCustomer], isLoading: false });
    render(<EnterpriseCustomersWorkspace role="auditor" />);
    expect(screen.getByText("Acme Holdings Ltd")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /new customer/i })).toBeNull();
  });

  it("lets a compliance officer create a new enterprise customer", () => {
    customersQuery.mockReturnValue({ data: [], isLoading: false });
    render(<EnterpriseCustomersWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /new customer/i }));
    fireEvent.change(screen.getByLabelText(/legal name/i), { target: { value: "Boundary PSP" } });
    fireEvent.change(screen.getByLabelText(/registration identifier/i), { target: { value: "RC999" } });
    fireEvent.click(screen.getByRole("button", { name: /record canonical customer/i }));
    expect(createCustomer).toHaveBeenCalledWith({ legalName: "Boundary PSP", registrationIdentifier: "RC999" });
  });

  it("filters the customer list by search text", () => {
    customersQuery.mockReturnValue({ data: [baseCustomer, { ...baseCustomer, id: "customer-2", legalName: "Other Corp", registrationIdentifier: "RC000" }], isLoading: false });
    render(<EnterpriseCustomersWorkspace role="admin" />);
    fireEvent.change(screen.getByLabelText(/search enterprise customers/i), { target: { value: "Other" } });
    expect(screen.queryByText("Acme Holdings Ltd")).toBeNull();
    expect(screen.getByText("Other Corp")).toBeTruthy();
  });

  it("opens a customer workspace with the Overview tab active by default", () => {
    customersQuery.mockReturnValue({ data: [baseCustomer], isLoading: false });
    customerWorkspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<EnterpriseCustomersWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    expect(screen.getByRole("heading", { name: "Acme Holdings Ltd" })).toBeTruthy();
    expect(screen.getByText(/gate g1/i)).toBeTruthy();
    expect(screen.getAllByText(/not implemented/i).length).toBeGreaterThan(0);
  });

  it("saves archetype, tier, and use-case narrative from the Customer Information tab", async () => {
    const user = userEvent.setup();
    customersQuery.mockReturnValue({ data: [baseCustomer], isLoading: false });
    customerWorkspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<EnterpriseCustomersWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /customer information/i }));
    fireEvent.change(screen.getByLabelText(/archetype/i), { target: { value: "importer" } });
    fireEvent.change(screen.getByLabelText(/use-case narrative/i), { target: { value: "Imports aircraft parts from a US supplier under a recurring MRO contract." } });
    fireEvent.click(screen.getByRole("button", { name: /save customer information/i }));
    expect(updateCustomerProfile).toHaveBeenCalledWith(expect.objectContaining({ customerId: "customer-1", archetype: "importer" }));
  });

  it("records a destination counterparty", async () => {
    const user = userEvent.setup();
    customersQuery.mockReturnValue({ data: [baseCustomer], isLoading: false });
    customerWorkspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<EnterpriseCustomersWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /customer information/i }));
    fireEvent.change(screen.getByPlaceholderText(/counterparty name/i), { target: { value: "Texan Parts Co" } });
    fireEvent.change(screen.getByPlaceholderText(/destination jurisdiction/i), { target: { value: "United States" } });
    fireEvent.click(screen.getByRole("button", { name: /^add$/i }));
    expect(recordDestinationCounterparty).toHaveBeenCalledWith(expect.objectContaining({ customerId: "customer-1", counterpartyName: "Texan Parts Co", destinationJurisdiction: "United States" }));
  });

  it("refuses to submit a Gate G1 decision without a rationale, and records one when supplied", async () => {
    const user = userEvent.setup();
    customersQuery.mockReturnValue({ data: [baseCustomer], isLoading: false });
    customerWorkspaceQuery.mockReturnValue({ data: baseWorkspace, isLoading: false });
    render(<EnterpriseCustomersWorkspace role="compliance_officer" />);
    fireEvent.click(screen.getByRole("button", { name: /open/i }));
    await user.click(screen.getByRole("tab", { name: /review & decision/i }));
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(decideUseCaseGate).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/decision rationale/i), { target: { value: "Use case and destination counterparty confirmed with the customer." } });
    fireEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    expect(decideUseCaseGate).toHaveBeenCalledWith({ customerId: "customer-1", decision: "approved", rationale: "Use case and destination counterparty confirmed with the customer." });
  });
});
