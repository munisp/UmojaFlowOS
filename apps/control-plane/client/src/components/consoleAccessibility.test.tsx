import axe from "axe-core";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { ComplianceCaseDispositionControls } from "./ComplianceCaseWorkflowControls";
import { KycDocumentReviewTable } from "./KycDocumentReviewControls";
import { KycDocumentUploadForm } from "./KycDocumentUploadControls";
import { PaymentOrderForm } from "./PaymentWorkflowControls";
import { PostgresCustomerOnboardingForm } from "./PostgresCustomerOnboardingForm";
import { PostgresReportDraftForm } from "./PostgresReportDraftForm";
import { PostgresReportTransitionForm } from "./PostgresReportTransitionForm";
import { RateLockForm } from "./RateLockControls";
import { RegulatoryDeadlineForm } from "./RegulatoryDeadlineControls";
import { SarStrFilingForm } from "./SarStrFilingControls";
import { StakeholderOnboardingWorkspace } from "./StakeholderOnboardingWorkspace";
import { TreasuryRecommendationForm } from "./TreasuryRebalancingControls";

/**
 * A real accessibility audit, not a proxy for one.
 *
 * These surfaces are how a compliance officer files a suspicious-activity
 * report and how a treasury operator drafts a payment. An unlabelled control or
 * an unreadable state here is an operational failure, not a cosmetic one. The
 * audit runs the actual axe-core rule engine against the actual rendered DOM.
 *
 * Two scope notes, both about what jsdom can express rather than about lowering
 * the bar. First, axe cannot evaluate colour contrast in jsdom, because jsdom
 * does not compute rendered colours; that rule is disabled here and contrast is
 * covered by the visual review in docs/visual-validation.md. Second, each
 * surface is a fragment of a page rather than a page, so it is rendered inside
 * a `main` landmark to satisfy the page-level `region` rule, which would
 * otherwise fire on every fragment for a reason that does not exist in the real
 * console. Every other rule runs unmodified.
 */
const AXE_OPTIONS: axe.RunOptions = {
  rules: { "color-contrast": { enabled: false } },
  resultTypes: ["violations"],
};

/** Renders a console fragment in the landmark context the real page provides. */
function renderInPageContext(node: Parameters<typeof render>[0]) {
  render(<main>{node}</main>);
}

async function auditRenderedSurface(): Promise<string[]> {
  const results = await axe.run(document.body, AXE_OPTIONS);
  return results.violations.map(
    violation =>
      `${violation.id} (${violation.impact ?? "unknown"}): ${violation.help} — ${violation.nodes
        .map(node => node.html)
        .slice(0, 3)
        .join(" | ")}`,
  );
}

const now = new Date("2026-08-18T12:00:00.000Z");

/** Each entry renders one console surface in a state an operator can reach. */
const surfaces: Array<{ name: string; render: () => void }> = [
  {
    name: "customer onboarding form",
    render: () => renderInPageContext(<PostgresCustomerOnboardingForm pending={false} submit={() => undefined} />),
  },
  {
    name: "regulatory deadline form",
    render: () => renderInPageContext(<RegulatoryDeadlineForm pending={false} submit={() => undefined} />),
  },
  {
    name: "SAR/STR filing form",
    render: () =>
      renderInPageContext(
        <SarStrFilingForm
          cases={[{ id: "0f8b1a2c-3d4e-4f50-8a61-b2c3d4e5f607", caseType: "kyc", sourceReference: "recorded-evidence-reference" }]}
          pending={false}
          submit={() => undefined}
        />,
      ),
  },
  {
    name: "report draft form",
    render: () => renderInPageContext(<PostgresReportDraftForm pending={false} submit={() => undefined} />),
  },
  {
    name: "report transition form",
    render: () =>
      renderInPageContext(
        <PostgresReportTransitionForm
          rows={[{ id: "1a2b3c4d-5e6f-4071-8293-a4b5c6d7e8f9", regulator: "CBN", reportType: "monthly-return" }]}
          pending={false}
          submit={() => undefined}
        />,
      ),
  },
  {
    name: "KYC document upload form",
    render: () =>
      renderInPageContext(
        <KycDocumentUploadForm
          customers={[{ id: "2b3c4d5e-6f70-4182-93a4-b5c6d7e8f901", legalName: "Registered Counterparty", kycStatus: "pending" }]}
          createIntent={async () => {
            throw new Error("not exercised by the accessibility audit");
          }}
          finalize={async () => {
            throw new Error("not exercised by the accessibility audit");
          }}
          onComplete={() => undefined}
        />,
      ),
  },
  {
    name: "KYC document review table",
    render: () =>
      renderInPageContext(
        <KycDocumentReviewTable
          rows={[
            {
              id: "3c4d5e6f-7081-4293-a4b5-c6d7e8f90123",
              customerLegalName: "Registered Counterparty",
              documentType: "identity_document",
              originalFilename: "passport.pdf",
              reviewStatus: "submitted",
              reviewNote: null,
              reviewedBy: null,
              reviewedAt: null,
              uploadedAt: now,
            },
          ]}
          loading={false}
          canReview
          pending={false}
          submit={() => undefined}
        />,
      ),
  },
  {
    name: "compliance case disposition controls",
    render: () =>
      renderInPageContext(
        <ComplianceCaseDispositionControls
          cases={[
            {
              id: "4d5e6f70-8192-43a4-b5c6-d7e8f9012345",
              caseType: "kyc",
              status: "open",
              severity: "low",
              sourceReference: "recorded-evidence-reference",
              openedAt: now,
            },
          ]}
          canDispose
          pending={false}
          dispose={() => undefined}
        />,
      ),
  },
  {
    name: "rate lock form",
    render: () =>
      renderInPageContext(
        <RateLockForm
          observations={[
            {
              id: "5e6f7081-92a3-44b5-c6d7-e8f901234567",
              baseAsset: "USD",
              quoteAsset: "NGN",
              rate: "1650.25",
              observedAt: now,
            },
          ]}
          pending={false}
          submit={() => undefined}
        />,
      ),
  },
  {
    name: "payment order form",
    render: () =>
      renderInPageContext(
        <PaymentOrderForm
          customers={[{ id: "6f708192-a3b4-45c6-d7e8-f90123456789", legalName: "Registered Counterparty" }]}
          beneficiaries={[
            {
              id: "708192a3-b4c5-46d7-e8f9-012345678901",
              customerId: "6f708192-a3b4-45c6-d7e8-f90123456789",
              legalName: "Named Beneficiary",
              screeningState: "pending",
            },
          ]}
          rateLocks={[
            {
              id: "8192a3b4-c5d6-47e8-f901-234567890123",
              corridor: "NIGERIA_NGN",
              baseAsset: "USD",
              quoteAsset: "NGN",
              lockedRate: "1650.25",
              status: "locked",
              expiresAt: new Date(now.getTime() + 3_600_000),
            },
          ]}
          pending={false}
          submit={() => undefined}
          now={now}
        />,
      ),
  },
  {
    name: "treasury proposal unavailable state",
    render: () => renderInPageContext(<TreasuryRecommendationForm policies={[]} pending={false} submit={() => undefined} />),
  },
  {
    name: "administrator stakeholder onboarding workspace",
    render: () =>
      renderInPageContext(
        <StakeholderOnboardingWorkspace
          role="admin"
          signals={{ counterparties: 0, integrations: 0, customers: 0, consents: 0, documents: 0, liquidityPositions: 0, marketObservations: 0, paymentOrders: 0, complianceCases: 0, reports: 0, auditEvents: 0 }}
          onNavigate={() => undefined}
        />,
      ),
  },
];

describe("console accessibility", () => {
  afterEach(cleanup);

  for (const surface of surfaces) {
    it(`has no axe violations on the ${surface.name}`, async () => {
      surface.render();
      const violations = await auditRenderedSurface();
      expect(violations).toEqual([]);
    });
  }

  it("audits every surface it claims to, and the audit is capable of failing", async () => {
    // Guard against a vacuous pass: the audit must actually detect a real
    // violation when one is present.
    renderInPageContext(
      <form>
        <input type="text" />
      </form>,
    );
    const violations = await auditRenderedSurface();
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.join(" ")).toMatch(/label/i);
  });
});
