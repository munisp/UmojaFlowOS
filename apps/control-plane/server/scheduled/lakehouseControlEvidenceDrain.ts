import type { Request, Response } from "express";

import { authenticateScheduledInvocation } from "./schedulerAuth";
import { drainLakehouseControlEvidence } from "../lakehouseControlEvidence";

/** Cron-only delivery of redacted, non-authoritative PostgreSQL control evidence. */
export async function lakehouseControlEvidenceDrain(req: Request, res: Response) {
  const invocation = authenticateScheduledInvocation(req);
  if (!invocation) return res.status(403).json({ error: "scheduler_only" });
  try {
    return res.json({ ok: true, ...(await drainLakehouseControlEvidence()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message, taskUid: invocation.taskUid, timestamp: new Date().toISOString() });
  }
}
