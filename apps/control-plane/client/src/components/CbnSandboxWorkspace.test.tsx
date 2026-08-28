import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { cbnSandboxDossiers: { invalidate: vi.fn() }, cbnSandboxReadiness: { invalidate: vi.fn() }, vaspRegulatoryProfiles: { invalidate: vi.fn() }, vaspSupervisoryReadiness: { invalidate: vi.fn() }, vaspTravelRuleAssessments: { invalidate: vi.fn() }, readinessAssurance: { invalidate: vi.fn() }, assessReadinessAssurance: { invalidate: vi.fn() } } }),
    postgres: {
      cbnSandboxDossiers: { useQuery: () => ({ data: [], isLoading: false }) },
      legalEntities: { useQuery: () => ({ data: [{ id: "entity-1", legalName: "Nigeria Applicant Ltd", jurisdiction: "Nigeria" }] }) },
      customers: { useQuery: () => ({ data: [] }) },
      cbnSandboxReadiness: { useQuery: () => ({ data: undefined, isLoading: false }) },
      cbnSandboxLatestEvidenceAssessment: { useQuery: () => ({ data: undefined, isLoading: false }) },
      vaspRegulatoryProfiles: { useQuery: () => ({ data: [] }) },
      vaspTravelRuleAssessments: { useQuery: () => ({ data: [] }) },
      vaspSupervisoryReadiness: { useQuery: () => ({ data: undefined, isLoading: false }) },
      counterparties: { useQuery: () => ({ data: [] }) },
      readinessAssurance: { useQuery: () => ({ data: [], isLoading: false }) },
      assessReadinessAssurance: { useQuery: () => ({ data: undefined, isLoading: false }) },
      createCbnSandboxDossier: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      recordCbnSandboxEvidence: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      assessCbnSandboxEvidenceCompleteness: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      createCbnSandboxTestPlan: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      recordCbnSandboxConsumerRecord: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      recordCbnSandboxIncident: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      createCbnSandboxReportingPack: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      createVaspRegulatoryProfile: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      recordVaspSupervisoryEvidence: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      recordVaspTravelRuleEvidence: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      assessVaspTravelRuleRoute: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      initialiseReadinessAssurance: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      recordReadinessAssuranceEvidence: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
      verifyReadinessAssuranceEvidence: { useMutation: () => ({ isPending: false, mutate: vi.fn() }) },
    },
  },
}));

import { CbnSandboxWorkspace } from "./CbnSandboxWorkspace";

describe("CBN sandbox workspace", () => {
  afterEach(cleanup);

  it("makes the non-licensing and non-submission boundary visible to every role", async () => {
    const user = userEvent.setup();
    render(<CbnSandboxWorkspace role="auditor" />);
    expect(screen.getByText(/does not submit to CBN, prove admission or licensing/i)).toBeTruthy();
    expect(screen.getByText(/No CBN dossier selected/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /New dossier/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /Assess records/i })).toBeNull();

    await user.click(screen.getByRole("tab", { name: /vasp supervisory/i }));
    expect(screen.getByText(/does not send a regulatory application, determine SEC or CBN status/i)).toBeTruthy();
    expect(screen.getByText(/Every route remains unverified externally and no transmission is initiated/i)).toBeTruthy();
  });

  it("allows an administrator to open a required-evidence dossier form without promising an external result", () => {
    render(<CbnSandboxWorkspace role="admin" />);
    fireEvent.click(screen.getByRole("button", { name: /New dossier/i }));

    expect(screen.getByText(/New CBN Cohort 2 readiness dossier/i)).toBeTruthy();
    expect((screen.getByRole("textbox", { name: /Product name/i }) as HTMLInputElement).required).toBe(true);
    expect((screen.getByRole("textbox", { name: /Product summary/i }) as HTMLTextAreaElement).minLength).toBe(50);
    expect(screen.getByRole("button", { name: /Record without external claim/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /submit to CBN/i })).toBeNull();
    expect(screen.getByRole("button", { name: /Assess records/i })).toBeTruthy();
  });
});
