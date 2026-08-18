import type { Request, Response } from "express";
import * as postgres from "../postgres";
import { sdk } from "../_core/sdk";

export async function counterpartyRiskReviews(req: Request, res: Response) {
  try {
    const user = await sdk.authenticateRequest(req);
    if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron_only" });
    const job = await postgres.getPostgresScheduledJobByTaskUid(user.taskUid);
    if (!job || !job.enabled || job.purpose !== "counterparty_risk_reviews") return res.json({ ok: true, skipped: "orphan_or_disabled" });
    const result = await postgres.evaluatePostgresCounterpartyRiskReviews({ openId: user.openId, role: "admin" });
    await postgres.markPostgresScheduledJobExecuted(user.taskUid);
    return res.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message, context: { url: req.originalUrl }, timestamp: new Date().toISOString() });
  }
}
