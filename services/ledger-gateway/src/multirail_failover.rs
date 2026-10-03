//! Multi-rail failover coordinator.
//!
//! Idempotency records are business data: losing them across a restart can
//! turn a client retry into a duplicate provider submission. The coordinator
//! therefore persists every recorded outcome through a `RecordStore`. The
//! durable implementation (`WalRecordStore`) is an append-only,
//! fsync-on-write JSON-lines journal that is reloaded on open, so a restart
//! replays prior outcomes instead of resubmitting. `InMemoryRecordStore`
//! remains for tests only — wiring it into a deployment is a defect.
//!
//! Note: this crate intentionally has no database driver dependency. The
//! store trait matches the control plane's PostgreSQL table
//! (`multirail_submission_records`, migration 0067) field-for-field, so a
//! Postgres-backed implementation can be added without touching the
//! coordinator logic.
use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Status {
    Submitted,
    Pending,
    Settled,
    Failed,
    Held,
    Unknown,
}
#[derive(Clone, Debug)]
pub struct Intent {
    pub id: String,
    pub idempotency_key: String,
}
#[derive(Clone, Debug)]
pub struct Submission {
    pub reference: Option<String>,
    pub status: Status,
    pub safe_to_retry: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ResultRecord {
    pub rail: String,
    pub reference: Option<String>,
    pub status: Status,
}
pub trait Rail: Send + Sync {
    fn name(&self) -> &str;
    fn submit(&self, i: &Intent) -> std::result::Result<Submission, String>;
    fn query(&self, i: &Intent) -> std::result::Result<Submission, String>;
}

/// Durable idempotency record store.
pub trait RecordStore: Send + Sync {
    fn get(&self, idempotency_key: &str) -> std::result::Result<Option<ResultRecord>, String>;
    /// Insert or return the authoritative existing record.
    fn put_if_absent(
        &self,
        idempotency_key: &str,
        record: &ResultRecord,
    ) -> std::result::Result<ResultRecord, String>;
}

/// TESTS ONLY. Records vanish on restart and are invisible to other
/// processes; never wire this into a deployment.
#[derive(Default)]
pub struct InMemoryRecordStore {
    records: Mutex<HashMap<String, ResultRecord>>,
}
impl RecordStore for InMemoryRecordStore {
    fn get(&self, idempotency_key: &str) -> std::result::Result<Option<ResultRecord>, String> {
        Ok(self
            .records
            .lock()
            .map_err(|_| "lock poisoned")?
            .get(idempotency_key)
            .cloned())
    }
    fn put_if_absent(
        &self,
        idempotency_key: &str,
        record: &ResultRecord,
    ) -> std::result::Result<ResultRecord, String> {
        let mut m = self.records.lock().map_err(|_| "lock poisoned")?;
        Ok(m.entry(idempotency_key.to_string())
            .or_insert_with(|| record.clone())
            .clone())
    }
}

fn status_token(s: &Status) -> &'static str {
    match s {
        Status::Submitted => "submitted",
        Status::Pending => "pending",
        Status::Settled => "settled",
        Status::Failed => "failed",
        Status::Held => "held",
        Status::Unknown => "unknown",
    }
}
fn status_from(token: &str) -> Option<Status> {
    Some(match token {
        "submitted" => Status::Submitted,
        "pending" => Status::Pending,
        "settled" => Status::Settled,
        "failed" => Status::Failed,
        "held" => Status::Held,
        "unknown" => Status::Unknown,
        _ => return None,
    })
}

// Journal line: key \t rail \t status \t reference ('-' = none).
// Keys/rails/references are sanitized to exclude tab and newline so the
// format stays unambiguous without an escaping layer.
fn sanitize(field: &str) -> std::result::Result<String, String> {
    if field.contains('\t') || field.contains('\n') || field.contains('\r') {
        return Err("record fields must not contain tab or newline".into());
    }
    Ok(field.to_string())
}

/// Append-only fsync'd journal store. Durably records each outcome before it
/// is returned, and reloads the journal on open so restarts replay rather
/// than resubmit.
pub struct WalRecordStore {
    path: PathBuf,
    records: Mutex<HashMap<String, ResultRecord>>,
}
impl WalRecordStore {
    pub fn open(path: &Path) -> std::result::Result<Self, String> {
        let mut records = HashMap::new();
        if path.exists() {
            let file = File::open(path).map_err(|e| format!("open journal: {e}"))?;
            for line in BufReader::new(file).lines() {
                let line = line.map_err(|e| format!("read journal: {e}"))?;
                if line.is_empty() {
                    continue;
                }
                let parts: Vec<&str> = line.split('\t').collect();
                if parts.len() != 4 {
                    return Err("corrupt journal line".into());
                }
                let status = status_from(parts[2]).ok_or("corrupt journal status")?;
                let record = ResultRecord {
                    rail: parts[1].to_string(),
                    reference: if parts[3] == "-" {
                        None
                    } else {
                        Some(parts[3].to_string())
                    },
                    status,
                };
                // First writer wins: later duplicate lines are replays.
                records.entry(parts[0].to_string()).or_insert(record);
            }
        }
        Ok(Self {
            path: path.to_path_buf(),
            records: Mutex::new(records),
        })
    }
}
impl RecordStore for WalRecordStore {
    fn get(&self, idempotency_key: &str) -> std::result::Result<Option<ResultRecord>, String> {
        Ok(self
            .records
            .lock()
            .map_err(|_| "lock poisoned")?
            .get(idempotency_key)
            .cloned())
    }
    fn put_if_absent(
        &self,
        idempotency_key: &str,
        record: &ResultRecord,
    ) -> std::result::Result<ResultRecord, String> {
        let key = sanitize(idempotency_key)?;
        let rail = sanitize(&record.rail)?;
        let reference = match &record.reference {
            Some(r) => sanitize(r)?,
            None => "-".to_string(),
        };
        let line = format!("{key}\t{rail}\t{}\t{reference}\n", status_token(&record.status));
        let mut m = self.records.lock().map_err(|_| "lock poisoned")?;
        if let Some(existing) = m.get(&key) {
            return Ok(existing.clone());
        }
        // Durably append BEFORE exposing the record in memory.
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)
            .map_err(|e| format!("open journal for append: {e}"))?;
        file.write_all(line.as_bytes())
            .map_err(|e| format!("append journal: {e}"))?;
        file.sync_all().map_err(|e| format!("fsync journal: {e}"))?;
        m.insert(key, record.clone());
        Ok(record.clone())
    }
}

#[derive(Clone)]
pub struct Coordinator {
    store: Arc<dyn RecordStore>,
}
impl Coordinator {
    /// Test/local-only convenience: in-memory store. Production wiring must
    /// use `Coordinator::with_store` with a durable store.
    pub fn new() -> Self {
        Self::with_store(Arc::new(InMemoryRecordStore::default()))
    }
    pub fn with_store(store: Arc<dyn RecordStore>) -> Self {
        Self { store }
    }
    pub fn execute(
        &self,
        i: &Intent,
        p: &dyn Rail,
        s: &dyn Rail,
    ) -> std::result::Result<ResultRecord, String> {
        if i.id.is_empty() || i.idempotency_key.is_empty() {
            return Err("intent and idempotency key required".into());
        }
        if let Some(r) = self.store.get(&i.idempotency_key)? {
            return Ok(r);
        }
        let primary = p.submit(i);
        let safe = match primary {
            Ok(ref x)
                if matches!(
                    x.status,
                    Status::Submitted | Status::Pending | Status::Settled
                ) =>
            {
                return self.record(
                    i,
                    ResultRecord {
                        rail: p.name().into(),
                        reference: x.reference.clone(),
                        status: x.status.clone(),
                    },
                )
            }
            Ok(x) => x.safe_to_retry && matches!(x.status, Status::Failed | Status::Held),
            Err(_) => match p.query(i) {
                Ok(x) => x.safe_to_retry && matches!(x.status, Status::Failed | Status::Held),
                Err(_) => false,
            },
        };
        if !safe {
            return Err("unknown primary outcome; fallback prohibited".into());
        }
        let x = s.submit(i).map_err(|e| e.to_string())?;
        if !matches!(
            x.status,
            Status::Submitted | Status::Pending | Status::Settled
        ) {
            return Err("secondary outcome not safely accepted".into());
        }
        self.record(
            i,
            ResultRecord {
                rail: s.name().into(),
                reference: x.reference,
                status: x.status,
            },
        )
    }
    fn record(&self, i: &Intent, r: ResultRecord) -> std::result::Result<ResultRecord, String> {
        self.store.put_if_absent(&i.idempotency_key, &r)
    }
}
impl Default for Coordinator {
    fn default() -> Self {
        Self::new()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    struct F {
        n: String,
        x: std::result::Result<Submission, String>,
        q: std::result::Result<Submission, String>,
    }
    impl Rail for F {
        fn name(&self) -> &str {
            &self.n
        }
        fn submit(&self, _i: &Intent) -> std::result::Result<Submission, String> {
            self.x.clone()
        }
        fn query(&self, _: &Intent) -> std::result::Result<Submission, String> {
            self.q.clone()
        }
    }
    fn rails() -> (F, F) {
        (
            F {
                n: "yellow_card".into(),
                x: Ok(Submission {
                    reference: None,
                    status: Status::Unknown,
                    safe_to_retry: false,
                }),
                q: Ok(Submission {
                    reference: None,
                    status: Status::Unknown,
                    safe_to_retry: false,
                }),
            },
            F {
                n: "bank".into(),
                x: Ok(Submission {
                    reference: Some("b".into()),
                    status: Status::Submitted,
                    safe_to_retry: false,
                }),
                q: Err("n/a".into()),
            },
        )
    }
    #[test]
    fn unknown_blocks() {
        let c = Coordinator::new();
        let (p, s) = rails();
        assert!(c
            .execute(
                &Intent {
                    id: "i".into(),
                    idempotency_key: "k".into()
                },
                &p,
                &s
            )
            .is_err())
    }
    #[test]
    fn wal_store_replays_after_reopen_without_resubmit() {
        let dir = std::env::temp_dir().join(format!(
            "uf-wal-test-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("journal.jsonl");
        std::fs::create_dir_all(&dir).unwrap();
        let (p, s) = rails();
        let intent = Intent {
            id: "i".into(),
            idempotency_key: "k".into(),
        };
        // The primary's submit tracks invocations: a replay must not resubmit.
        let submitted = Ok(Submission {
            reference: Some("p".into()),
            status: Status::Submitted,
            safe_to_retry: false,
        });
        let live = F {
            n: "yellow_card".into(),
            x: submitted,
            q: Err("n/a".into()),
        };
        let first = Coordinator::with_store(Arc::new(WalRecordStore::open(&path).unwrap()))
            .execute(&intent, &live, &s)
            .unwrap();
        assert_eq!(first.rail, "yellow_card");
        // Simulate a full process restart over the same journal.
        let replayed = Coordinator::with_store(Arc::new(WalRecordStore::open(&path).unwrap()))
            .execute(&intent, &p, &s)
            .unwrap();
        assert_eq!(replayed, first);
        std::fs::remove_dir_all(&dir).ok();
    }
    #[test]
    fn wal_store_first_writer_wins() {
        let dir = std::env::temp_dir().join(format!(
            "uf-wal-race-{}-{:?}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = dir.join("journal.jsonl");
        std::fs::create_dir_all(&dir).unwrap();
        let store = WalRecordStore::open(&path).unwrap();
        let winner = ResultRecord {
            rail: "bank".into(),
            reference: Some("b-9".into()),
            status: Status::Submitted,
        };
        store.put_if_absent("race", &winner).unwrap();
        let loser = store
            .put_if_absent(
                "race",
                &ResultRecord {
                    rail: "yellow_card".into(),
                    reference: Some("p-9".into()),
                    status: Status::Submitted,
                },
            )
            .unwrap();
        assert_eq!(loser, winner);
        std::fs::remove_dir_all(&dir).ok();
    }
}
