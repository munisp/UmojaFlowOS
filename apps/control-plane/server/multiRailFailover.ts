export type Status = 'submitted'|'pending'|'settled'|'failed'|'held'|'unknown';
export type Intent = { id:string; idempotencyKey:string };
export type Submission = { status:Status; providerRef?:string; safeToRetry?:boolean };
export interface Rail { readonly name:string; submit(i:Intent):Promise<Submission>; query(i:Intent):Promise<Submission>; }
export class UnknownOutcome extends Error { constructor(message='provider outcome unknown; fallback prohibited'){super(message);this.name='UnknownOutcome';} }
export class MultiRailCoordinator { private readonly records=new Map<string,{rail:string;submission:Submission}>();
  async execute(i:Intent,primary:Rail,secondary:Rail):Promise<{rail:string;submission:Submission}>{
    if(!i.id||!i.idempotencyKey) throw new Error('intent and idempotency key required');
    const cached=this.records.get(i.idempotencyKey); if(cached)return cached;
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
  private record(i:Intent,rail:string,submission:Submission){const prior=this.records.get(i.idempotencyKey);if(prior)return prior;const r={rail,submission};this.records.set(i.idempotencyKey,r);return r;}
}
