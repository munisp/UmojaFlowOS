import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";

export type ScheduledInvocation = { taskUid: string; openId: string };

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function headerValue(request: Request, name: string): string | undefined {
  const viaExpress = typeof request.header === "function" ? request.header(name) : undefined;
  if (typeof viaExpress === "string") return viaExpress;
  const raw = request.headers?.[name.toLowerCase()];
  return Array.isArray(raw) ? raw[0] : raw;
}

/**
 * Accepts only a preconfigured scheduler secret and an explicit schedule ID.
 * The caller must be a trusted scheduler running outside the public browser
 * path; a missing configuration or malformed request fails closed.
 */
export function authenticateScheduledInvocation(request: Request): ScheduledInvocation | null {
  const expected = process.env.UMOJA_SCHEDULER_TOKEN;
  const provided = headerValue(request, "x-umoja-scheduler-token");
  const taskUid = headerValue(request, "x-umoja-schedule-id");
  if (!expected || !provided || !taskUid || !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(taskUid)) return null;
  if (!equal(expected, provided)) return null;
  return { taskUid, openId: `scheduler:${taskUid}` };
}
