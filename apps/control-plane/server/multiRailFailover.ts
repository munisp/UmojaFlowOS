/**
 * Multi-rail failover coordinator.
 *
 * Idempotency records are business data: losing them across a restart can turn
 * a client retry into a duplicate provider submission. The coordinator
 * therefore persists every recorded outcome through a SubmissionRecordStore.
 * The Postgres store (migration 0067) is the production path and is race-safe
 * across replicas (INSERT ... ON CONFLICT DO NOTHING, then authoritative
 * SELECT). The in-memory store remains for unit tests and single-process local
 * development only — wiring it into a deployed environment is a defect.
 */
export type Status = 'submitted'|'pending'|'settled'|'failed'|'held'|'unknown';
export type Intent = { id:string; idempotencyKey:string };
export type Submission = { status:Status; providerRef?:string; safeToRetry?:boolean };
export type SubmissionRecord = { rail:string; submission:Submission };
export interface Rail { readonly name:string; submit(i:Intent):Promise<Submission>; query(i:Intent):Promise<Submission>; }
export class UnknownOutcome extends Error { constructor(message='provider outcome unknown; fallback prohibited'){super(message);this.name='UnknownOutcome';} }

/** Minimal pg-compatible surface so the store is testable against PGlite. */
export interface Querier {
  query<T = unknown>(text:string, params?:unknown[]):Promise<{ rows:T[] }>;
}

export interface SubmissionRecordStore {
  get(idempotencyKey:string):Promise<SubmissionRecord|undefined>;
  /** Insert or return the authoritative existing record (replica race-safe). */
  putIfAbsent(idempotencyKey:string, intentId:string, record:SubmissionRecord):Promise<SubmissionRecord>;
}

/**
 * TESTS AND SINGLE-PROCESS LOCAL DEVELOPMENT ONLY. Records vanish on restart
 * and are invisible to other replicas; never wire this into a deployment.
 */
export class InMemorySubmissionRecordStore implements SubmissionRecordStore {
  private readonly records = new Map<string,SubmissionRecord>();
  async get(idempotencyKey:string){ return this.records.get(idempotencyKey); }
  async putIfAbsent(_key:string, _intentId:string, record:SubmissionRecord){
    const prior = this.records.get(_key);
    if (prior) return prior;
    this.records.set(_key, record);
    return record;
  }
}

type Row = { rail:string; status:Status; provider_ref:string|null; safe_to_retry:boolean|null };

function toRecord(row:Row):SubmissionRecord {
  return { rail:row.rail, submission:{ status:row.status, providerRef:row.provider_ref ?? undefined, safeToRetry:row.safe_to_retry ?? undefined } };
}

/** Canonical durable store backed by PostgreSQL (migration 0067). */
export class PostgresSubmissionRecordStore implements SubmissionRecordStore {
  constructor(private readonly db:Querier){}
  async get(idempotencyKey:string){
    const res = await this.db.query<Row>(
      'SELECT rail, status, provider_ref, safe_to_retry FROM multirail_submission_records WHERE idempotency_key=$1',
      [idempotencyKey],
    );
    return res.rows[0] ? toRecord(res.rows[0]) : undefined;
  }
  async putIfAbsent(idempotencyKey:string, intentId:string, record:SubmissionRecord){
    const inserted = await this.db.query<Row>(
      `INSERT INTO multirail_submission_records (idempotency_key, intent_id, rail, status, provider_ref, safe_to_retry)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING rail, status, provider_ref, safe_to_retry`,
      [idempotencyKey, intentId, record.rail, record.submission.status, record.submission.providerRef ?? null, record.submission.safeToRetry ?? null],
    );
    if (inserted.rows[0]) return toRecord(inserted.rows[0]);
    // Lost the insert race (or replay): the stored row is authoritative.
    const existing = await this.get(idempotencyKey);
    if (!existing) throw new Error('multirail submission record vanished after insert conflict');
    return existing;
  }
}

/** Production factory: binds the store to the server pool. */
export async function createPostgresSubmissionRecordStore():Promise<PostgresSubmissionRecordStore> {
  const { getPool } = await import('./postgres');
  return new PostgresSubmissionRecordStore(getPool());
}

export class MultiRailCoordinator {
  /**
   * @param store defaults to the in-memory store so existing unit tests keep
   * working unchanged; production wiring must pass
   * `await createPostgresSubmissionRecordStore()`.
   */
  constructor(private readonly store:SubmissionRecordStore = new InMemorySubmissionRecordStore()){}
  async execute(i:Intent,primary:Rail,secondary:Rail):Promise<{rail:string;submission:Submission}>{
    if(!i.id||!i.idempotencyKey) throw new Error('intent and idempotency key required');
    const cached=await this.store.get(i.idempotencyKey); if(cached)return cached;
    let first:Submission;
    try{first=await primary.submit(i);}catch{
      try{first=await primary.query(i);}catch{throw new UnknownOutcome();}
    }
    if(['submitted','pending','settled'].includes(first.status)) return this.record(i,primary.name,first);
    if(!first.safeToRetry || !['failed','held'].includes(first.status)) throw new UnknownOutcome();
    const second=await secondary.submit(i);
    if(!['submitted','pending','settled'].includes(second.status))throw new UnknownOutcome('secondary outcome not accepted');
    return this.record(i,secondary.name,second);
  }
  private async record(i:Intent,rail:string,submission:Submission){
    return this.store.putIfAbsent(i.idempotencyKey, i.id, {rail,submission});
  }
}
