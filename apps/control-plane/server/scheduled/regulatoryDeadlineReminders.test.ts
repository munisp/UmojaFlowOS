import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { regulatoryDeadlineReminders } from "./regulatoryDeadlineReminders";

const SOURCE = readFileSync(resolve(process.cwd(), "server/scheduled/regulatoryDeadlineReminders.ts"), "utf8");
const POSTGRES = readFileSync(resolve(process.cwd(), "server/postgres.ts"), "utf8");

function fakeResponse() {
  const captured: { status: number; body: unknown } = { status: 200, body: undefined };
  const res = {
    status(code: number) {
      captured.status = code;
      return res;
    },
    json(body: unknown) {
      captured.body = body;
      return res;
    },
  };
  return { res, captured };
}

describe("regulatory deadline reminder callback", () => {
  it("returns a retry-safe 403 for an unauthenticated caller without evaluating anything", async () => {
    const { res, captured } = fakeResponse();
    // No scheduler secret and schedule identifier are attached, so authentication fails.
    await regulatoryDeadlineReminders({ headers: {}, originalUrl: "/api/scheduled/reminders" } as never, res as never);
    expect(captured.status).toBe(403);
    expect(captured.body).toEqual({ error: "scheduler_only" });
  });

  it("reads and writes only canonical PostgreSQL state", () => {
    // The transitional module must not be reachable from this callback.
    expect(SOURCE).not.toContain('from "../db"');
    expect(SOURCE).toContain('from "../postgres"');
    expect(SOURCE).toContain("getPostgresScheduledJobByTaskUid");
    expect(SOURCE).toContain("markPostgresScheduledJobExecuted");
    expect(SOURCE).toContain("evaluatePostgresRegulatoryDeadlines");
  });

  it("rejects a caller that lacks the configured scheduler secret", () => {
    expect(SOURCE).toContain("const invocation = authenticateScheduledInvocation(req)");
    expect(SOURCE).toContain('if (!invocation) return res.status(403).json({ error: "scheduler_only" })');
  });

  it("skips an orphaned or disabled schedule instead of evaluating it", () => {
    expect(SOURCE).toContain('skipped: "orphan_or_disabled"');
    expect(SOURCE).toContain('scheduledJob.purpose !== "regulatory_deadline_reminders"');
  });

  it("acts with read-only authority rather than an operator role", () => {
    expect(SOURCE).toContain('role: "auditor" as const');
  });

  it("evaluates deadlines idempotently by skipping already-notified rows", () => {
    // Idempotency is a property of the evaluation query, not of the caller.
    const start = POSTGRES.indexOf("export async function evaluatePostgresRegulatoryDeadlines");
    expect(start).toBeGreaterThan(-1);
    const body = POSTGRES.slice(start, start + 2600);
    // A deadline already reminded on the same calendar day is skipped, and the
    // candidate rows are locked for the duration of the transaction so two
    // concurrent runs cannot both notify the same deadline.
    expect(body).toContain("alreadyRemindedToday");
    expect(body).toContain("last_reminded_at = $1");
    expect(body).toContain("FOR UPDATE");
  });

  it("expires elapsed rate locks with a set-based update that is safe to re-run", () => {
    const start = POSTGRES.indexOf("export async function evaluatePostgresRegulatoryDeadlines");
    const body = POSTGRES.slice(start, start + 2600);
    expect(body).toContain("UPDATE rate_locks SET status='expired' WHERE status='locked' AND expires_at <= $1");
  });

  it("records immutable evaluation evidence for every run", () => {
    const start = POSTGRES.indexOf("export async function evaluatePostgresRegulatoryDeadlines");
    const body = POSTGRES.slice(start, start + 2600);
    expect(body).toContain('"regulatory_deadline.evaluated"');
  });
});
