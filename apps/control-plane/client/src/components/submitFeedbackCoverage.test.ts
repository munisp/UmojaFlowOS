import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Feedback coverage is enforced structurally rather than remembered. A form
 * added later without inline feedback would otherwise degrade quietly: the
 * submission would still work, so no test would fail, and only an operator
 * would notice the silence after pressing the button.
 */
const DIR = join(process.cwd(), "client/src/components");

// Each entry names a component that owns a submit control and the file holding
// it. Table-embedded action controls are listed separately below because they
// report through their own row rather than a form-level region.
const FORMS: Array<[string, string]> = [
  ["PostgresCustomerOnboardingForm", "PostgresCustomerOnboardingForm.tsx"],
  ["PostgresReportDraftForm", "PostgresReportDraftForm.tsx"],
  ["PostgresReportTransitionForm", "PostgresReportTransitionForm.tsx"],
  ["AnalysisJobSubmissionForm", "AnalysisJobSubmissionForm.tsx"],
  ["VerificationConsentForm", "ComplianceCaseWorkflowControls.tsx"],
  ["CounterpartyAuthorizationForm", "CounterpartyAuthorizationControls.tsx"],
  ["RateLockForm", "RateLockControls.tsx"],
  ["RegulatoryDeadlineForm", "RegulatoryDeadlineControls.tsx"],
  ["SarStrFilingForm", "SarStrFilingControls.tsx"],
  ["IntegrationCredentialForm", "IntegrationCredentialControls.tsx"],
];

describe("submission feedback coverage", () => {
  it.each(FORMS)("%s renders inline submission feedback", (component, file) => {
    const source = readFileSync(join(DIR, file), "utf8");
    expect(source).toContain("<SubmitFeedback");
    expect(source).toContain("useSubmitFeedback");
    // The component must actually accept an error to display; a feedback
    // element wired to nothing is decoration.
    expect(source).toMatch(/error\?: string \| null/);
    expect(component).toBeTruthy();
  });

  it("supplies each form's error from its own mutation in the console", () => {
    const home = readFileSync(join(process.cwd(), "client/src/pages/Home.tsx"), "utf8");
    // PostgresCustomerOnboardingForm's rendering site moved into its own
    // workspace component; every candidate site is checked so a form isn't
    // marked uncovered just because it no longer lives in Home.tsx.
    const workspace = readFileSync(join(DIR, "EnterpriseCustomersWorkspace.tsx"), "utf8");
    for (const [component] of FORMS) {
      if (component === "IntegrationCredentialForm") continue; // wired through its own panel props
      const usage = new RegExp(`<${component}[^>]*error=\\{`);
      expect(usage.test(home) || usage.test(workspace), `${component} is rendered without an error prop`).toBe(true);
    }
  });
});
