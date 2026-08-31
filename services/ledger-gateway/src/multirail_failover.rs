use std::collections::HashMap;
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, PartialEq, Eq)] pub enum Status { Submitted, Pending, Settled, Failed, Held, Unknown }
#[derive(Clone, Debug)] pub struct Intent { pub id:String, pub idempotency_key:String }
#[derive(Clone, Debug)] pub struct Submission { pub reference:Option<String>, pub status:Status, pub safe_to_retry:bool }
#[derive(Clone, Debug, PartialEq, Eq)] pub struct ResultRecord { pub rail:String, pub reference:Option<String>, pub status:Status }
pub trait Rail: Send + Sync { fn name(&self)->&str; fn submit(&self, i:&Intent)->std::result::Result<Submission,String>; fn query(&self, i:&Intent)->std::result::Result<Submission,String>; }
#[derive(Clone)] pub struct Coordinator { records:Arc<Mutex<HashMap<String,ResultRecord>>> }
impl Coordinator { pub fn new()->Self{Self{records:Arc::new(Mutex::new(HashMap::new()))}}
 pub fn execute(&self,i:&Intent,p:&dyn Rail,s:&dyn Rail)->std::result::Result<ResultRecord,String>{
  if i.id.is_empty()||i.idempotency_key.is_empty(){return Err("intent and idempotency key required".into())}
  if let Some(r)=self.records.lock().unwrap().get(&i.idempotency_key).cloned(){return Ok(r)}
  let primary=p.submit(i);
  let safe=match primary { Ok(ref x) if matches!(x.status,Status::Submitted|Status::Pending|Status::Settled)=>return self.record(i,ResultRecord{rail:p.name().into(),reference:x.reference.clone(),status:x.status.clone()}), Ok(x)=>x.safe_to_retry && matches!(x.status,Status::Failed|Status::Held), Err(_)=>match p.query(i){Ok(x)=>x.safe_to_retry && matches!(x.status,Status::Failed|Status::Held),Err(_)=>false} };
  if !safe{return Err("unknown primary outcome; fallback prohibited".into())}
  let x=s.submit(i).map_err(|e|e.to_string())?;
  if !matches!(x.status,Status::Submitted|Status::Pending|Status::Settled){return Err("secondary outcome not safely accepted".into())}
  self.record(i,ResultRecord{rail:s.name().into(),reference:x.reference,status:x.status})
 }
 fn record(&self,i:&Intent,r:ResultRecord)->std::result::Result<ResultRecord,String>{let mut m=self.records.lock().map_err(|_|"lock poisoned")?;Ok(m.entry(i.idempotency_key.clone()).or_insert(r).clone())}
}
#[cfg(test)] mod tests { use super::*; struct F{n:String,x:std::result::Result<Submission,String>,q:std::result::Result<Submission,String>} impl Rail for F{fn name(&self)->&str{&self.n}fn submit(&self,_i:&Intent)->std::result::Result<Submission,String>{self.x.clone()}fn query(&self,_:&Intent)->std::result::Result<Submission,String>{self.q.clone()}}
 #[test]fn unknown_blocks(){let c=Coordinator::new();let p=F{n:"yellow_card".into(),x:Ok(Submission{reference:None,status:Status::Unknown,safe_to_retry:false}),q:Ok(Submission{reference:None,status:Status::Unknown,safe_to_retry:false})};let s=F{n:"bank".into(),x:Ok(Submission{reference:Some("b".into()),status:Status::Submitted,safe_to_retry:false}),q:Err("n/a".into())};assert!(c.execute(&Intent{id:"i".into(),idempotency_key:"k".into()},&p,&s).is_err())}
}
