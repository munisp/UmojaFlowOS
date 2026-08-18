import { describe, expect, it } from "vitest";

import {
  createPostgresRegulatoryDeadline,
  evaluatePostgresRegulatoryDeadlines,
  listPostgresRegulatoryDeadlines,
} from "./postgres";

const RUN_INTEGRATION = process.env.POSTGRES_INTEGRATION_TEST === "1";
const describeIntegration = RUN_INTEGRATION ? describe : describe.skip;

const compliance = { openId: "regression-compliance-deadline", role: "compliance_officer" as const };
const scheduler = { openId: "regression-scheduler-deadline", role: "auditor" as const };

describeIntegration("canonical regulatory deadline reminder evaluation", () => {
  it("reminds a deadline inside the horizon exactly once per day and expires nothing it should not", async () => {
    // A real deadline record, 24 hours out, which is inside the 72-hour horizon.
    const dueAt = new Date(Date.now() + 24 * 3_600_000);
    const created = await createPostgresRegulatoryDeadline(compliance, {
      regulator: "CBN",
      corridor: "NIGERIA_NGN",
      title: "regression-deadline CBN quarterly cross-border position return",
      dueAt,
      sourceReference: "regression-deadline://cbn/quarterly-return/2026Q3",
    });
    expect(created.id).toBeTruthy();

    const first = await evaluatePostgresRegulatoryDeadlines(scheduler);
    expect(first.evaluated).toBeGreaterThan(0);

    // Re-running the same evaluation on the same day must not remind again.
    const second = await evaluatePostgresRegulatoryDeadlines(scheduler);
    expect(second.reminded).toBe(0);

    const deadlines = await listPostgresRegulatoryDeadlines();
    const persisted = deadlines.find(row => row.id === created.id);
    expect(persisted).toBeDefined();
    // The deadline stays open; a reminder is not a disposition.
    expect(persisted?.status).toBe("open");
  });

  it("leaves a deadline beyond the horizon unreminded", async () => {
    const dueAt = new Date(Date.now() + 30 * 24 * 3_600_000);
    const created = await createPostgresRegulatoryDeadline(compliance, {
      regulator: "SARB",
      corridor: "SOUTH_AFRICA_ZAR",
      title: "regression-deadline SARB annual exchange-control attestation",
      dueAt,
      sourceReference: "regression-deadline://sarb/annual-attestation/2026",
    });

    const before = await listPostgresRegulatoryDeadlines();
    const beforeRow = before.find(row => row.id === created.id);
    await evaluatePostgresRegulatoryDeadlines(scheduler);
    const after = await listPostgresRegulatoryDeadlines();
    const afterRow = after.find(row => row.id === created.id);

    // A deadline 30 days out is outside the 72-hour horizon, so its reminder
    // stamp must be unchanged by the run.
    expect(afterRow?.lastRemindedAt ?? null).toEqual(beforeRow?.lastRemindedAt ?? null);
  });

  it("refuses to create a deadline without a source reference", async () => {
    await expect(
      createPostgresRegulatoryDeadline(compliance, {
        regulator: "CBK",
        corridor: "KENYA_KES",
        title: "regression-deadline CBK monthly return",
        dueAt: new Date(Date.now() + 48 * 3_600_000),
        sourceReference: "   ",
      }),
    ).rejects.toThrow();
  });
});
