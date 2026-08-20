import type { Request, Response } from "express";
import * as postgres from "../postgres";
import { authenticateScheduledInvocation } from "./schedulerAuth";

export async function counterpartyRiskReviews(req: Request, res: Response) {
  try {
    const invocation = authenticateScheduledInvocation(req);
    if (!invocation) return res.status(403).json({ error: "scheduler_only" });
    const job = await postgres.getPostgresScheduledJobByTaskUid(invocation.taskUid);
    if (!job || !job.enabled || job.purpose !== "counterparty_risk_reviews") return res.json({ ok: true, skipped: "orphan_or_disabled" });
    const result = await postgres.evaluatePostgresCounterpartyRiskReviews({ openId: invocation.openId, role: "admin" });
    await postgres.markPostgresScheduledJobExecuted(invocation.taskUid);
    return res.json({ ok: true, ...result });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message, context: { url: req.originalUrl }, timestamp: new Date().toISOString() });
  }
}
