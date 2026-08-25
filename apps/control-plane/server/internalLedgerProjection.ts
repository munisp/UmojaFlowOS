import type { Express, Request, Response } from "express";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { realpathSync, readFileSync } from "node:fs";
import { resolve, relative } from "node:path";
import { recordInternalLedgerProjection } from "./postgres";

const PROJECTION_PATH = "/internal/ledger/projections";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_AGE_MS = 5 * 60 * 1000;
const CURRENCIES = new Set(["NGN", "KES", "ZAR", "USD", "USDC", "USDT"]);
const DECIMAL = /^[1-9][0-9]*$/;
const SHA256 = /^[a-f0-9]{64}$/;

type ProjectionPayload = {
  transfer_id: string;
  correlation_id: string;
  currency: string;
  amount_minor: string;
  debit_account_id: string;
  credit_account_id: string;
  posted_at: string;
  evidence_sha256: string;
};

function secretFromManagedReference() {
  const reference = process.env.UMOJA_LEDGER_PROJECTION_HMAC_SECRET_REFERENCE?.trim() ?? "";
  const root = process.env.UMOJA_PROVIDER_MATERIAL_ROOT?.trim() || "/run/umoja-secrets";
  if (!reference.startsWith("file:///")) throw new Error("ledger projection secret reference must be a file:/// path");
  const rootPath = realpathSync(root);
  const candidatePath = realpathSync(resolve(reference.slice("file://".length)));
  const rel = relative(rootPath, candidatePath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error("ledger projection secret reference escapes the managed root");
  }
  const secret = readFileSync(candidatePath);
  if (secret.length < 16) throw new Error("ledger projection secret material is unavailable");
  return secret;
}

function reject(response: Response, code: number, message: string) {
  response.status(code).json({ error: message });
}

function parsePayload(body: Buffer): ProjectionPayload {
  if (body.length === 0 || body.length > MAX_BODY_BYTES) throw new Error("ledger projection body has an invalid size");
  const value: unknown = JSON.parse(body.toString("utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ledger projection body must be an object");
  const payload = value as Record<string, unknown>;
  const expected = ["transfer_id", "correlation_id", "currency", "amount_minor", "debit_account_id", "credit_account_id", "posted_at", "evidence_sha256"];
  if (Object.keys(payload).length !== expected.length || expected.some(key => typeof payload[key] !== "string")) {
    throw new Error("ledger projection body does not match the fixed evidence contract");
  }
  const parsed = payload as unknown as ProjectionPayload;
  if (!DECIMAL.test(parsed.transfer_id) || !DECIMAL.test(parsed.amount_minor) || !DECIMAL.test(parsed.debit_account_id) || !DECIMAL.test(parsed.credit_account_id)) {
    throw new Error("ledger projection identifiers and amount must be positive decimal strings");
  }
  if (parsed.debit_account_id === parsed.credit_account_id || !CURRENCIES.has(parsed.currency) || !SHA256.test(parsed.evidence_sha256) || parsed.correlation_id.trim().length === 0 || parsed.correlation_id.length > 255 || Number.isNaN(Date.parse(parsed.posted_at))) {
    throw new Error("ledger projection evidence is incomplete or invalid");
  }
  return parsed;
}

function verifyRequest(request: Request, body: Buffer) {
  const timestamp = request.header("x-umoja-internal-timestamp") ?? "";
  const signature = request.header("x-umoja-internal-signature") ?? "";
  const when = Date.parse(timestamp);
  if (!timestamp || Number.isNaN(when) || Math.abs(Date.now() - when) > MAX_AGE_MS) throw new Error("ledger projection timestamp is outside the accepted window");
  const provided = Buffer.from(signature, "base64");
  const bodyDigest = createHash("sha256").update(body).digest("base64");
  const secret = secretFromManagedReference();
  const expected = createHmac("sha256", secret).update(`${timestamp}POST${PROJECTION_PATH}${bodyDigest}`).digest();
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw new Error("ledger projection signature is invalid");
}

export function registerInternalLedgerProjection(app: Express) {
  app.post(PROJECTION_PATH, async (request, response) => {
    try {
      if (!Buffer.isBuffer(request.body)) return reject(response, 415, "ledger projection requires an octet-stream protected body");
      verifyRequest(request, request.body);
      const input = parsePayload(request.body);
      const result = await recordInternalLedgerProjection({
        transferId: input.transfer_id,
        correlationId: input.correlation_id,
        currency: input.currency as "NGN" | "KES" | "ZAR" | "USD" | "USDC" | "USDT",
        amountMinor: input.amount_minor,
        debitAccountId: input.debit_account_id,
        creditAccountId: input.credit_account_id,
        postedAt: new Date(input.posted_at),
        evidenceSha256: input.evidence_sha256,
      });
      return response.status(result.recorded ? 201 : 200).json({ recorded: result.recorded, reconciliation_state: result.reconciliationState });
    } catch (error) {
      const message = error instanceof Error ? error.message : "ledger projection was rejected";
      const status = /signature|timestamp|secret/.test(message) ? 401 : /body|evidence|identifier|currency|account/.test(message) ? 422 : 503;
      return reject(response, status, message);
    }
  });
}
