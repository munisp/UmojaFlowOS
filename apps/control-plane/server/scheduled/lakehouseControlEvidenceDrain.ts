import type { Request, Response } from "express";

import { sdk } from "../_core/sdk";
import { drainLakehouseControlEvidence } from "../lakehouseControlEvidence";

/** Cron-only delivery of redacted, non-authoritative PostgreSQL control evidence. */
export async function lakehouseControlEvidenceDrain(req: Request, res: Response) {
  let user: Awaited<ReturnType<typeof sdk.authenticateRequest>>;
  try {
    user = await sdk.authenticateRequest(req);
  } catch {
    return res.status(403).json({ error: "cron_only" });
  }
  if (!user.isCron || !user.taskUid) return res.status(403).json({ error: "cron_only" });
  try {
    return res.json({ ok: true, ...(await drainLakehouseControlEvidence()) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message, taskUid: user.taskUid, timestamp: new Date().toISOString() });
  }
}
