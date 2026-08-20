import type { Request, Response } from "express";

import { authenticateScheduledInvocation } from "./schedulerAuth";
import { collectAllServiceStatuses } from "../serviceHealth";
import { recordServiceHealthSamples } from "../serviceHealthHistory";

/**
 * Cron-only collection of one service health round.
 *
 * Idempotent in the sense the scheduler requires: a repeated call records an
 * additional observation rather than corrupting an earlier one. That is the
 * correct semantics for a time series — two collections a second apart are two
 * genuine observations, not a duplicate — and it is why this handler does not
 * attempt deduplication the way the deadline job does.
 *
 * Collection never throws on a service being down; an unreachable service is
 * itself the observation worth recording.
 */
export async function serviceHealthCollector(req: Request, res: Response) {
  const invocation = authenticateScheduledInvocation(req);
  if (!invocation) return res.status(403).json({ error: "scheduler_only" });

  try {
    const collected = await collectAllServiceStatuses();
    const written = await recordServiceHealthSamples(collected.services);
    return res.json({
      ok: true,
      written,
      observedAt: collected.observedAt,
      // Reported back so the scheduler's own log shows what was seen, which is
      // useful when diagnosing a gap in the chart later.
      statuses: collected.services.map(service => ({ service: service.service, status: service.status })),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return res.status(500).json({ error: message, context: { url: req.originalUrl, taskUid: invocation.taskUid }, timestamp: new Date().toISOString() });
  }
}
