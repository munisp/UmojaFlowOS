import { getPool, type Actor } from "./postgres";

/**
 * TigerBeetle ↔ PostgreSQL reconciliation persistence (migration 0042).
 *
 * Previously orphaned schema: ledger_posting_intents, ledger_reconciliation_runs
 * and ledger_reconciliation_discrepancies had no writer, so reconciliation
 * evidence between the authoritative TigerBeetle ledger and the PostgreSQL
 * projection was never persisted. This module records intent, comparison
 * outcomes and discrepancies; it never asserts settlement by itself.
 */

const RECON_CURRENCIES = ["NGN", "KES", "ZAR", "USD", "USDC", "USDT"] as const;

export async function recordLedgerPostingIntent(actor: Actor, input: {
  postingIdentity: string;
  correlationId: string;
  currency: (typeof RECON_CURRENCIES)[number];
  amountMinor: string;
  debitAccountId: number;
  creditAccountId: number;
  expectedTransferId?: number | null;
}) {
  if (input.debitAccountId === input.creditAccountId) throw new Error("debit and credit accounts must differ");
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO ledger_posting_intents
       (posting_identity, correlation_id, currency, amount_minor, debit_account_id, credit_account_id, expected_transfer_id)
     VALUES ($1,$2,$3,$4::numeric,$5,$6,$7)
     ON CONFLICT (posting_identity) DO NOTHING
     RETURNING id`,
    [
      input.postingIdentity, input.correlationId, input.currency, input.amountMinor,
      input.debitAccountId, input.creditAccountId, input.expectedTransferId ?? null,
    ],
  );
  return { id: rows[0]?.id ?? null };
}

export async function transitionLedgerPostingIntent(actor: Actor, input: {
  postingIdentity: string;
  intentState: "posted" | "voided" | "blocked";
  expectedTransferId?: number | null;
}) {
  const { rowCount } = await getPool().query(
    `UPDATE ledger_posting_intents
        SET intent_state=$2,
            expected_transfer_id=COALESCE($3, expected_transfer_id)
      WHERE posting_identity=$1 AND intent_state = 'approved'`,
    [input.postingIdentity, input.intentState, input.expectedTransferId ?? null],
  );
  if (rowCount === 0) throw new Error("posting intent not found or no longer in approved state");
}

export async function recordLedgerReconciliationRun(actor: Actor, input: {
  runReference: string;
  windowStart: Date;
  windowEnd: Date;
  status: "reconciled" | "discrepancy" | "indeterminate";
  intentCount: number;
  factCount: number;
  discrepancyCount: number;
  sourceIdentity: string;
  errorSummary?: string | null;
}) {
  if (input.windowEnd <= input.windowStart) throw new Error("window_end must be after window_start");
  if (input.status === "reconciled" && input.discrepancyCount !== 0) throw new Error("reconciled runs must have zero discrepancies");
  if (input.status === "discrepancy" && input.discrepancyCount === 0) throw new Error("discrepancy runs must have discrepancies");
  if (input.status === "indeterminate" && (!input.errorSummary || input.errorSummary.trim().length < 8)) {
    throw new Error("indeterminate runs require an error summary of at least 8 characters");
  }
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO ledger_reconciliation_runs
       (run_reference, window_start, window_end, status, intent_count, fact_count,
        discrepancy_count, source_identity, error_summary, completed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (run_reference) DO NOTHING
     RETURNING id`,
    [
      input.runReference, input.windowStart, input.windowEnd, input.status,
      input.intentCount, input.factCount, input.discrepancyCount,
      input.sourceIdentity, input.errorSummary ?? null,
    ],
  );
  return { id: rows[0]?.id ?? null };
}

export async function recordLedgerReconciliationDiscrepancy(actor: Actor, input: {
  runId: string;
  postingIdentity?: string | null;
  tigerbeetleTransferId?: number | null;
  discrepancyCode: "missing_fact" | "unexpected_fact" | "field_mismatch" | "duplicate_identity" | "invalid_balance";
  expected?: Record<string, unknown> | null;
  observed?: Record<string, unknown> | null;
}) {
  const { rows } = await getPool().query<{ id: string }>(
    `INSERT INTO ledger_reconciliation_discrepancies
       (run_id, posting_identity, tigerbeetle_transfer_id, discrepancy_code, expected, observed)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6::jsonb) RETURNING id`,
    [
      input.runId, input.postingIdentity ?? null, input.tigerbeetleTransferId ?? null,
      input.discrepancyCode, JSON.stringify(input.expected ?? null), JSON.stringify(input.observed ?? null),
    ],
  );
  return { id: rows[0].id };
}

export async function listLedgerPostingIntents(intentState?: string) {
  const { rows } = await getPool().query(
    `SELECT id, posting_identity AS "postingIdentity", correlation_id AS "correlationId", currency,
            amount_minor AS "amountMinor", debit_account_id AS "debitAccountId", credit_account_id AS "creditAccountId",
            expected_transfer_id AS "expectedTransferId", intent_state AS "intentState", created_at AS "createdAt"
       FROM ledger_posting_intents
      ${intentState ? "WHERE intent_state=$1" : ""}
      ORDER BY created_at DESC LIMIT 500`,
    intentState ? [intentState] : [],
  );
  return rows;
}

export async function listLedgerReconciliationRuns(status?: string) {
  const { rows } = await getPool().query(
    `SELECT id, run_reference AS "runReference", window_start AS "windowStart", window_end AS "windowEnd",
            status, intent_count AS "intentCount", fact_count AS "factCount",
            discrepancy_count AS "discrepancyCount", source_identity AS "sourceIdentity",
            error_summary AS "errorSummary", started_at AS "startedAt", completed_at AS "completedAt"
       FROM ledger_reconciliation_runs
      ${status ? "WHERE status=$1" : ""}
      ORDER BY started_at DESC LIMIT 200`,
    status ? [status] : [],
  );
  return rows;
}

export async function listLedgerReconciliationDiscrepancies(runId: string) {
  const { rows } = await getPool().query(
    `SELECT id, posting_identity AS "postingIdentity", tigerbeetle_transfer_id AS "tigerbeetleTransferId",
            discrepancy_code AS "discrepancyCode", expected, observed, recorded_at AS "recordedAt"
       FROM ledger_reconciliation_discrepancies WHERE run_id=$1 ORDER BY recorded_at DESC LIMIT 500`,
    [runId],
  );
  return rows;
}
