/**
 * Multi-rail failover coordinator with durable idempotency records.
 *
 * Persistence: submission records MUST be durable so that a retry after a
 * process restart returns the original outcome instead of double-submitting
 * to a payment rail. Use `createPostgresSubmissionRecordStore()` in
 * production (migration 0067); the in-memory store is for tests/dev only.
 */

export type RailStatus = "submitted" | "pending" | "settled" | "failed" | "held" | "unknown";

export interface SubmissionRecord {
  idempotencyKey: string;
  intentId: string;
  rail: string;
  status: RailStatus;
  providerRef?: string | null;
  safeToRetry?: boolean | null;
}

export interface Querier {
  query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: T[] }>;
}

export interface SubmissionRecordStore {
  get(idempotencyKey: string): Promise<SubmissionRecord | undefined>;
  /** First-writer-wins: returns the authoritative record for the key. */
  putIfAbsent(record: SubmissionRecord): Promise<SubmissionRecord>;
}

/** TESTS/DEV ONLY — loses all records on restart. */
export class InMemorySubmissionRecordStore implements SubmissionRecordStore {
  private readonly records = new Map<string, SubmissionRecord>();
  async get(key: string) {
    return this.records.get(key);
  }
  async putIfAbsent(record: SubmissionRecord) {
    const existing = this.records.get(record.idempotencyKey);
    if (existing) return existing;
    this.records.set(record.idempotencyKey, record);
    return record;
  }
}

interface Row {
  idempotency_key: string;
  intent_id: string;
  rail: string;
  status: RailStatus;
  provider_ref: string | null;
  safe_to_retry: boolean | null;
}

const toRecord = (r: Row): SubmissionRecord => ({
  idempotencyKey: r.idempotency_key,
  intentId: r.intent_id,
  rail: r.rail,
  status: r.status,
  providerRef: r.provider_ref,
  safeToRetry: r.safe_to_retry,
});

export class PostgresSubmissionRecordStore implements SubmissionRecordStore {
  constructor(private readonly db: Querier) {}

  async get(key: string): Promise<SubmissionRecord | undefined> {
    const { rows } = await this.db.query<Row>(
      "SELECT idempotency_key, intent_id, rail, status, provider_ref, safe_to_retry FROM multirail_submission_records WHERE idempotency_key = $1",
      [key],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async putIfAbsent(record: SubmissionRecord): Promise<SubmissionRecord> {
    const { rows } = await this.db.query<Row>(
      `INSERT INTO multirail_submission_records (idempotency_key, intent_id, rail, status, provider_ref, safe_to_retry)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING idempotency_key, intent_id, rail, status, provider_ref, safe_to_retry`,
      [record.idempotencyKey, record.intentId, record.rail, record.status, record.providerRef ?? null, record.safeToRetry ?? null],
    );
    if (rows[0]) return toRecord(rows[0]);
    // Lost the insert race: the winner's row is authoritative.
    const existing = await this.get(record.idempotencyKey);
    if (!existing) {
      throw new Error(`multirail_submission_records row vanished for key ${record.idempotencyKey}`);
    }
    return existing;
  }
}

/** Production factory: resolves the shared pool lazily to avoid import cycles. */
export async function createPostgresSubmissionRecordStore(): Promise<PostgresSubmissionRecordStore> {
  const mod = await import("./postgres");
  return new PostgresSubmissionRecordStore(mod.getPool());
}

export interface RailSubmissionResult {
  status: RailStatus;
  providerRef?: string;
  safeToRetry?: boolean;
}

export interface RailAdapter {
  name: string;
  submit(intentId: string): Promise<RailSubmissionResult>;
}

const BLOCKING: RailStatus[] = ["submitted", "pending", "settled", "held", "unknown"];

export class MultiRailCoordinator {
  constructor(private readonly store: SubmissionRecordStore = new InMemorySubmissionRecordStore()) {}

  /**
   * Submit with idempotency: a retry of the same key returns the original
   * outcome; only a record that is explicitly failed AND safeToRetry may
   * fall through to the next rail.
   */
  async execute(intentId: string, idempotencyKey: string, rails: RailAdapter[]): Promise<SubmissionRecord> {
    const prior = await this.store.get(idempotencyKey);
    if (prior) return prior;

    let lastFailure: SubmissionRecord | undefined;
    for (const rail of rails) {
      const result = await rail.submit(intentId);
      const record = await this.store.putIfAbsent({
        idempotencyKey,
        intentId,
        rail: rail.name,
        status: result.status,
        providerRef: result.providerRef ?? null,
        safeToRetry: result.safeToRetry ?? null,
      });
      if (record.idempotencyKey !== idempotencyKey || record.intentId !== intentId) {
        // Another concurrent execution owns this key.
        return record;
      }
      if (BLOCKING.includes(record.status)) return record;
      if (record.status === "failed" && record.safeToRetry) {
        lastFailure = record;
        continue;
      }
      return record;
    }
    return lastFailure ?? {
      idempotencyKey,
      intentId,
      rail: "none",
      status: "failed",
      safeToRetry: false,
    };
  }
}
