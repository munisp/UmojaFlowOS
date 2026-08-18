import { describe, expect, it } from "vitest";

import { disposeComplianceCase } from "./complianceCaseWorkflow";
import { createPostgresComplianceCase, listPostgresActivityEventsForObjects, listPostgresComplianceCases } from "./postgres";

const RUN_INTEGRATION = process.env.POSTGRES_INTEGRATION_TEST === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const officer = { openId: `regression-case-officer-${Date.now()}`, role: "compliance_officer" };

async function openCase(sourceReference: string) {
  return createPostgresComplianceCase(officer as never, {
    caseType: "transaction_monitoring",
    severity: "high",
    sourceReference,
    decisionReason: undefined,
  } as never);
}

describeIntegration("canonical compliance-case disposition", () => {
  it("drives a case through review to a reported and then closed disposition with audit evidence", async () => {
    const opened = await openCase(`regression-case://monitoring/${Date.now()}`);
    expect(opened.status).toBe("open");

    const reviewed = await disposeComplianceCase(officer, {
      complianceCaseId: opened.id,
      status: "under_review",
      decisionReason: "Assigned for manual review against the recorded transaction-monitoring source evidence.",
    });
    expect(reviewed.status).toBe("under_review");

    const reported = await disposeComplianceCase(officer, {
      complianceCaseId: opened.id,
      status: "reported",
      decisionReason: "Manual review concluded the activity is reportable under the corridor obligation.",
    });
    expect(reported.status).toBe("reported");

    const closed = await disposeComplianceCase(officer, {
      complianceCaseId: opened.id,
      status: "closed",
      decisionReason: "Case closed following the recorded report; no further action is outstanding.",
    });
    expect(closed.status).toBe("closed");

    // Every disposition wrote its own immutable event carrying both endpoints.
    const events = await listPostgresActivityEventsForObjects([opened.id]);
    const dispositions = events.filter(event => event.action === "compliance_case.disposed");
    expect(dispositions.length).toBe(3);
    for (const event of dispositions) {
      const metadata = event.metadata as Record<string, unknown>;
      expect(typeof metadata.fromStatus).toBe("string");
      expect(typeof metadata.toStatus).toBe("string");
      expect(String(metadata.decisionReason).length).toBeGreaterThanOrEqual(20);
    }
  });

  it("refuses to reopen a closed case", async () => {
    const opened = await openCase(`regression-case://closed/${Date.now()}`);
    await disposeComplianceCase(officer, {
      complianceCaseId: opened.id,
      status: "closed",
      decisionReason: "Closed without review because the source reference was withdrawn by the originator.",
    });
    await expect(
      disposeComplianceCase(officer, {
        complianceCaseId: opened.id,
        status: "under_review",
        decisionReason: "Attempting to reopen a closed case must fail so an earlier attestation is never overwritten.",
      }),
    ).rejects.toThrow(/cannot transition/i);
  });

  it("refuses a disposition without an attributable rationale", async () => {
    const opened = await openCase(`regression-case://rationale/${Date.now()}`);
    await expect(
      disposeComplianceCase(officer, { complianceCaseId: opened.id, status: "under_review", decisionReason: "too short" }),
    ).rejects.toThrow(/attributable rationale/i);

    // The refused disposition left the case in its original state.
    const cases = await listPostgresComplianceCases();
    expect(cases.find(row => row.id === opened.id)?.status).toBe("open");
  });

  it("refuses a disposition on an unknown case", async () => {
    await expect(
      disposeComplianceCase(officer, {
        complianceCaseId: "00000000-0000-4000-8000-000000000000",
        status: "under_review",
        decisionReason: "A disposition against a non-existent case must fail closed rather than create one.",
      }),
    ).rejects.toThrow(/not found/i);
  });
});
