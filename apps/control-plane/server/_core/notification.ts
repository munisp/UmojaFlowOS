import { createHmac } from "node:crypto";
import { TRPCError } from "@trpc/server";

export type NotificationPayload = { title: string; content: string };
const TITLE_MAX_LENGTH = 1200;
const CONTENT_MAX_LENGTH = 20000;

function validatePayload(input: NotificationPayload): NotificationPayload {
  const title = input.title?.trim();
  const content = input.content?.trim();
  if (!title || !content || title.length > TITLE_MAX_LENGTH || content.length > CONTENT_MAX_LENGTH) throw new TRPCError({ code: "BAD_REQUEST", message: "Notification content is invalid." });
  return { title, content };
}

/** Delivers to a tenant-selected HTTPS webhook. A missing endpoint is an explicit no-delivery outcome. */
export async function notifyOwner(input: NotificationPayload): Promise<boolean> {
  const payload = validatePayload(input);
  const endpoint = process.env.UMOJA_ALERT_WEBHOOK_URL;
  const secret = process.env.UMOJA_ALERT_WEBHOOK_SECRET;
  if (!endpoint || !secret) return false;
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  if (url.protocol !== "https:") return false;
  const body = JSON.stringify({ ...payload, occurredAt: new Date().toISOString() });
  const signature = createHmac("sha256", secret).update(body).digest("hex");
  try {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-umoja-signature": `sha256=${signature}` }, body, signal: AbortSignal.timeout(10_000) });
    return response.ok;
  } catch { return false; }
}
