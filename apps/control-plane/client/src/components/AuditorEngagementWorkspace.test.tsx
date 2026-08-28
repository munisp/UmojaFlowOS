import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const engagementsQuery = vi.fn();
const startEngagement = vi.fn();
const recordLetter = vi.fn();
const recordAccess = vi.fn();
const recordFieldwork = vi.fn();
const recordReview = vi.fn();

const baseEngagement = {
  id: "engagement-1",
  auditorFirmName: "KPMG Nigeria",
  engagementReference: "FY2026 external audit",
  phase: "engagement_letter" as const,
  engagementLetterUri: null,
  engagementLetterSignedAt: null,
  scopeNote: null,
  auditorSubject: null,
  accessProvisionedAt: null,
  accessProvisionedBy: null,
  fieldworkNote: null,
  fieldworkStartedAt: null,
  fieldworkCompletedAt: null,
  lastAnnualReviewAt: null,
  nextAnnualReviewDueAt: null,
  createdAt: new Date("2026-08-01T00:00:00Z"),
};

vi.mock("@/lib/trpc", () => ({
  trpc: {
    useUtils: () => ({ postgres: { auditorEngagements: { invalidate: vi.fn() } } }),
    postgres: {
      auditorEngagements: { useQuery: () => engagementsQuery() },
      startAuditorEngagement: { useMutation: () => ({ isPending: false, mutate: startEngagement, error: null }) },
      recordEngagementLetter: { useMutation: () => ({ isPending: false, mutate: recordLetter, error: null }) },
      recordAccessProvisioning: { useMutation: () => ({ isPending: false, mutate: recordAccess, error: null }) },
      recordAuditFieldwork: { useMutation: () => ({ isPending: false, mutate: recordFieldwork, error: null }) },
      recordAnnualReview: { useMutation: () => ({ isPending: false, mutate: recordReview, error: null }) },
    },
  },
}));

import { AuditorEngagementWorkspace } from "./AuditorEngagementWorkspace";

describe("auditor engagement workspace", () => {
  afterEach(cleanup);

  it("withholds the workspace from a non-admin role", () => {
    engagementsQuery.mockReturnValue({ data: [], isLoading: false });
    render(<AuditorEngagementWorkspace role="compliance_officer" />);
    expect(screen.getByText(/only administrators may view or manage/i)).toBeTruthy();
  });

  it("starts a new engagement with firm name and engagement reference", () => {
    engagementsQuery.mockReturnValue({ data: [], isLoading: false });
    render(<AuditorEngagementWorkspace role="admin" />);
    fireEvent.change(screen.getByPlaceholderText(/kpmg nigeria/i), { target: { value: "EY Nigeria" } });
    fireEvent.change(screen.getByPlaceholderText(/fy2026 external audit/i), { target: { value: "FY2027 external audit" } });
    fireEvent.click(screen.getByRole("button", { name: /start engagement/i }));
    expect(startEngagement).toHaveBeenCalledWith({ auditorFirmName: "EY Nigeria", engagementReference: "FY2027 external audit" });
  });

  it("lists engagements and expands the current phase panel", () => {
    engagementsQuery.mockReturnValue({ data: [baseEngagement], isLoading: false });
    render(<AuditorEngagementWorkspace role="admin" />);
    expect(screen.getByText("KPMG Nigeria")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /engagement letter/i }));
    expect(screen.getByText(/current phase: engagement letter/i)).toBeTruthy();
  });

  it("requires a scope note before recording the engagement letter", () => {
    engagementsQuery.mockReturnValue({ data: [baseEngagement], isLoading: false });
    render(<AuditorEngagementWorkspace role="admin" />);
    fireEvent.click(screen.getByRole("button", { name: /engagement letter/i }));
    fireEvent.click(screen.getByRole("button", { name: /record engagement letter/i }));
    expect(recordLetter).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText(/engagement letter url/i), { target: { value: "https://example.com/letter.pdf" } });
    fireEvent.change(screen.getByPlaceholderText(/^scope note$/i), { target: { value: "Full-scope annual audit covering treasury and compliance controls." } });
    fireEvent.click(screen.getByRole("button", { name: /record engagement letter/i }));
    expect(recordLetter).toHaveBeenCalledWith({ engagementId: "engagement-1", engagementLetterUri: "https://example.com/letter.pdf", scopeNote: "Full-scope annual audit covering treasury and compliance controls." });
  });

  it("records access provisioning with the auditor's platform subject", () => {
    const provisioning = { ...baseEngagement, phase: "access_provisioning" as const, engagementLetterUri: "https://example.com/letter.pdf", engagementLetterSignedAt: new Date("2026-08-05T00:00:00Z"), scopeNote: "Full scope." };
    engagementsQuery.mockReturnValue({ data: [provisioning], isLoading: false });
    render(<AuditorEngagementWorkspace role="admin" />);
    fireEvent.click(screen.getByRole("button", { name: /access provisioning/i }));
    fireEvent.change(screen.getByPlaceholderText(/auditor's platform subject/i), { target: { value: "kc_auditor1" } });
    fireEvent.click(screen.getByRole("button", { name: /record access provisioning/i }));
    expect(recordAccess).toHaveBeenCalledWith({ engagementId: "engagement-1", auditorSubject: "kc_auditor1" });
  });

  it("records an annual review with a next-due date once fieldwork has concluded", () => {
    const steadyState = { ...baseEngagement, phase: "annual_review" as const, lastAnnualReviewAt: null, nextAnnualReviewDueAt: null };
    engagementsQuery.mockReturnValue({ data: [steadyState], isLoading: false });
    render(<AuditorEngagementWorkspace role="admin" />);
    fireEvent.click(screen.getByRole("button", { name: /annual review/i }));
    fireEvent.change(screen.getByLabelText(/next review due/i), { target: { value: "2027-08-01" } });
    fireEvent.click(screen.getByRole("button", { name: /record annual review/i }));
    expect(recordReview).toHaveBeenCalledWith({ engagementId: "engagement-1", nextAnnualReviewDueAt: new Date("2027-08-01") });
  });
});
