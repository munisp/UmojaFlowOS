import type { Request, Response } from "express";

import { sdk } from "../_core/sdk";
import {
  evaluatePostgresRegulatoryDeadlines,
  getPostgresScheduledJobByTaskUid,
  markPostgresScheduledJobExecuted,
} from "../postgres";
import { expirePostgresRateLocks } from "../paymentWorkflow";

/**
 * Cron-only evaluation of CBN, CBK, and SARB reporting deadlines.
 *
 * The callback is idempotent by construction: deadline evaluation only notifies
 * deadlines that have not yet been notified, and rate-lock expiry is a
 * set-based update over locks that have already elapsed. Re-running the job
 * therefore produces no duplicate notification and no second state change.
 *
 * An unauthenticated or non-cron caller receives 403 rather than an error, so a
 * misrouted request is not retried indefinitely by the scheduler.
 */
export async function regulatoryDeadlineReminders(req: Request, res: Response) {
  let user: Awaited<ReturnType<typeof sdk.authenticateRequest>>;
  try {
    user = await sdk.authenticateRequest(req);
  } catch {
    return res.status(403).json({ error: "cron_only" });
  }

  if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron_only" });

  try {
    const scheduledJob = await getPostgresScheduledJobByTaskUid(user.taskUid);
    if (!scheduledJob || !scheduledJob.enabled || scheduledJob.purpose !== "regulatory_deadline_reminders") {
      // An orphaned or disabled schedule is reported as handled so the
      // scheduler stops retrying it, but nothing is evaluated.
      return res.json({ ok: true, skipped: "orphan_or_disabled" });
    }

    // The scheduler is not a human operator, so it acts with read-only
    // authority. Both operations below are evaluations, never approvals.
    const actor = { openId: user.openId, role: "auditor" as const };
    const rateLocks = await expirePostgresRateLocks(actor);
    const deadlines = await evaluatePostgresRegulatoryDeadlines(actor);
    await markPostgresScheduledJobExecuted(user.taskUid);

    return res.json({ ok: true, ...deadlines, ...rateLocks });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message, context: { url: req.originalUrl }, timestamp: new Date().toISOString() });
  }
}
