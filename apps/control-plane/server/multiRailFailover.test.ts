import { describe, expect, it } from 'vitest';
import { MultiRailCoordinator, UnknownOutcome, type Intent, type Rail } from './multiRailFailover';
const i:Intent={id:'i',idempotencyKey:'k'};
const rail=(name:string,submit:any,query:any=submit):Rail=>({name,submit:async()=>submit,query:async()=>query});
describe('multi-rail failover',()=>{
 it('falls back after confirmed non-submission',async()=>{const r=await new MultiRailCoordinator().execute(i,rail('yellow_card',{status:'failed',safeToRetry:true}),rail('bank',{status:'submitted',providerRef:'b'}));expect(r.rail).toBe('bank');});
 it('blocks fallback after unknown outcome',async()=>{const bank=rail('bank',{status:'submitted'});await expect(new MultiRailCoordinator().execute(i,rail('yellow_card',{status:'unknown'}),bank)).rejects.toBeInstanceOf(UnknownOutcome);});
 it('queries after timeout and blocks unknown result',async()=>{const bank=rail('bank',{status:'submitted'});await expect(new MultiRailCoordinator().execute(i,rail('yellow_card',Promise.reject(new Error('timeout')),{status:'unknown'}),bank)).rejects.toBeInstanceOf(UnknownOutcome);});
 it('returns cached result for duplicate idempotency key',async()=>{let calls=0;const p:Rail={name:'yellow_card',submit:async()=>{calls++;return {status:'submitted',providerRef:'p'}},query:async()=>({status:'unknown'})};const c=new MultiRailCoordinator();const a=await c.execute(i,p,rail('bank',{status:'submitted'}));const b=await c.execute(i,p,rail('bank',{status:'submitted'}));expect(a).toEqual(b);expect(calls).toBe(1);});
});
