import type { Request, Response } from "express";
import * as db from "../db";
import { sdk } from "../_core/sdk";

export async function regulatoryDeadlineReminders(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron_only" });
    const scheduledJob = await db.getScheduledJobByTaskUid(user.taskUid);
    if (!scheduledJob || !scheduledJob.enabled || scheduledJob.purpose !== "regulatory_deadline_reminders") {
      return res.json({ ok: true, skipped: "orphan_or_disabled" });
    }
    const actor = { openId: user.openId, role: "auditor" as const };
    const rateLocks = await db.expireRateLocks(actor);
    const result = await db.evaluateRegulatoryDeadlineAlerts(actor);
    await db.markScheduledJobExecuted(user.taskUid);
    return res.json({ ok: true, ...result, ...rateLocks });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message, context: { url: req.originalUrl }, timestamp: new Date().toISOString() });
  }
}
