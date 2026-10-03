//! Durable idempotency records for multirail payment submissions.
//!
//! The coordinator must never double-submit to a rail after a restart.
//! Production deployments should back the coordinator with `WalRecordStore`
//! (fsync'd append-only journal) or another durable `RecordStore`;
//! `InMemoryRecordStore` is for tests/local dev only.

use std::collections::HashMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::Path;
use std::sync::{Arc, Mutex};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RailStatus {
    Submitted,
    Pending,
    Settled,
    Failed,
    Held,
    Unknown,
}

impl RailStatus {
    fn as_str(&self) -> &'static str {
        match self {
            RailStatus::Submitted => "submitted",
            RailStatus::Pending => "pending",
            RailStatus::Settled => "settled",
            RailStatus::Failed => "failed",
            RailStatus::Held => "held",
            RailStatus::Unknown => "unknown",
        }
    }

    fn from_str(s: &str) -> Option<Self> {
        match s {
            "submitted" => Some(RailStatus::Submitted),
            "pending" => Some(RailStatus::Pending),
            "settled" => Some(RailStatus::Settled),
            "failed" => Some(RailStatus::Failed),
            "held" => Some(RailStatus::Held),
            "unknown" => Some(RailStatus::Unknown),
            _ => None,
        }
    }

    fn blocks_retry(&self) -> bool {
        !matches!(self, RailStatus::Failed)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResultRecord {
    pub idempotency_key: String,
    pub intent_id: String,
    pub rail: String,
    pub status: RailStatus,
    pub provider_ref: Option<String>,
    pub safe_to_retry: Option<bool>,
}

pub trait RecordStore: Send + Sync {
    fn get(&self, idempotency_key: &str) -> Result<Option<ResultRecord>, String>;
    /// First-writer-wins: returns the authoritative record for the key.
    fn put_if_absent(&self, record: ResultRecord) -> Result<ResultRecord, String>;
}

/// TESTS/LOCAL DEV ONLY — loses all records on restart.
#[derive(Default)]
pub struct InMemoryRecordStore {
    records: Mutex<HashMap<String, ResultRecord>>,
}

impl RecordStore for InMemoryRecordStore {
    fn get(&self, key: &str) -> Result<Option<ResultRecord>, String> {
        Ok(self.records.lock().map_err(|e| e.to_string())?.get(key).cloned())
    }
    fn put_if_absent(&self, record: ResultRecord) -> Result<ResultRecord, String> {
        let mut guard = self.records.lock().map_err(|e| e.to_string())?;
        Ok(guard
            .entry(record.idempotency_key.clone())
            .or_insert(record)
            .clone())
    }
}

/// Append-only fsync'd JSONL journal. The write is durable BEFORE the
/// in-memory cache is updated; on open the journal is replayed with
/// first-writer-wins semantics.
pub struct WalRecordStore {
    file: Mutex<File>,
    cache: Mutex<HashMap<String, ResultRecord>>,
}

fn sanitize(field: &str) -> Result<&str, String> {
    if field.contains('\t') || field.contains('\n') || field.contains('\r') {
        return Err("field contains illegal separator characters".to_string());
    }
    Ok(field)
}

fn encode(record: &ResultRecord) -> Result<String, String> {
    Ok(format!(
        "{}\t{}\t{}\t{}\t{}\t{}\n",
        sanitize(&record.idempotency_key)?,
        sanitize(&record.intent_id)?,
        sanitize(&record.rail)?,
        record.status.as_str(),
        record.provider_ref.as_deref().unwrap_or(""),
        record.safe_to_retry.map(|b| b.to_string()).unwrap_or_default(),
    ))
}

fn decode(line: &str) -> Option<ResultRecord> {
    let f: Vec<&str> = line.trim_end().split('\t').collect();
    if f.len() != 6 {
        return None;
    }
    Some(ResultRecord {
        idempotency_key: f[0].to_string(),
        intent_id: f[1].to_string(),
        rail: f[2].to_string(),
        status: RailStatus::from_str(f[3])?,
        provider_ref: if f[4].is_empty() { None } else { Some(f[4].to_string()) },
        safe_to_retry: match f[5] {
            "" => None,
            "true" => Some(true),
            "false" => Some(false),
            _ => return None,
        },
    })
}

impl WalRecordStore {
    pub fn open(path: &Path) -> Result<Self, String> {
        let mut cache = HashMap::new();
        if path.exists() {
            let reader = BufReader::new(File::open(path).map_err(|e| e.to_string())?);
            for line in reader.lines() {
                let line = line.map_err(|e| e.to_string())?;
                if line.trim().is_empty() {
                    continue;
                }
                if let Some(record) = decode(&line) {
                    // First writer wins on replay.
                    cache.entry(record.idempotency_key.clone()).or_insert(record);
                }
            }
        }
        let file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
            .map_err(|e| e.to_string())?;
        Ok(Self { file: Mutex::new(file), cache: Mutex::new(cache) })
    }
}

impl RecordStore for WalRecordStore {
    fn get(&self, key: &str) -> Result<Option<ResultRecord>, String> {
        Ok(self.cache.lock().map_err(|e| e.to_string())?.get(key).cloned())
    }

    fn put_if_absent(&self, record: ResultRecord) -> Result<ResultRecord, String> {
        {
            let cache = self.cache.lock().map_err(|e| e.to_string())?;
            if let Some(existing) = cache.get(&record.idempotency_key) {
                return Ok(existing.clone());
            }
        }
        let line = encode(&record)?;
        {
            let mut file = self.file.lock().map_err(|e| e.to_string())?;
            file.write_all(line.as_bytes()).map_err(|e| e.to_string())?;
            file.sync_all().map_err(|e| e.to_string())?; // durable BEFORE cache insert
        }
        let mut cache = self.cache.lock().map_err(|e| e.to_string())?;
        Ok(cache
            .entry(record.idempotency_key.clone())
            .or_insert(record)
            .clone())
    }
}

pub struct RailSubmissionResult {
    pub status: RailStatus,
    pub provider_ref: Option<String>,
    pub safe_to_retry: Option<bool>,
}

pub trait RailAdapter: Send + Sync {
    fn name(&self) -> &str;
    fn submit(&self, intent_id: &str) -> Result<RailSubmissionResult, String>;
}

pub struct Coordinator {
    store: Arc<dyn RecordStore>,
}

impl Coordinator {
    /// In-memory store — tests/local dev only.
    pub fn new() -> Self {
        Self { store: Arc::new(InMemoryRecordStore::default()) }
    }

    pub fn with_store(store: Arc<dyn RecordStore>) -> Self {
        Self { store }
    }

    /// Submit with idempotency: a retry of the same key returns the original
    /// outcome; only an explicitly failed + safe_to_retry record falls
    /// through to the next rail.
    pub fn execute(
        &self,
        intent_id: &str,
        idempotency_key: &str,
        rails: &[Box<dyn RailAdapter>],
    ) -> Result<ResultRecord, String> {
        if let Some(prior) = self.store.get(idempotency_key)? {
            return Ok(prior);
        }
        let mut last_failure: Option<ResultRecord> = None;
        for rail in rails {
            let result = rail.submit(intent_id)?;
            let record = self.store.put_if_absent(ResultRecord {
                idempotency_key: idempotency_key.to_string(),
                intent_id: intent_id.to_string(),
                rail: rail.name().to_string(),
                status: result.status,
                provider_ref: result.provider_ref,
                safe_to_retry: result.safe_to_retry,
            })?;
            if record.idempotency_key != idempotency_key || record.intent_id != intent_id {
                return Ok(record); // another execution owns this key
            }
            if record.status.blocks_retry() {
                return Ok(record);
            }
            if record.status == RailStatus::Failed && record.safe_to_retry == Some(true) {
                last_failure = Some(record);
                continue;
            }
            return Ok(record);
        }
        Ok(last_failure.unwrap_or(ResultRecord {
            idempotency_key: idempotency_key.to_string(),
            intent_id: intent_id.to_string(),
            rail: "none".to_string(),
            status: RailStatus::Failed,
            provider_ref: None,
            safe_to_retry: Some(false),
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct StubRail {
        name: &'static str,
        status: RailStatus,
        safe_to_retry: Option<bool>,
        calls: Arc<AtomicUsize>,
    }

    impl RailAdapter for StubRail {
        fn name(&self) -> &str {
            self.name
        }
        fn submit(&self, _intent_id: &str) -> Result<RailSubmissionResult, String> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(RailSubmissionResult {
                status: self.status.clone(),
                provider_ref: Some("ref".to_string()),
                safe_to_retry: self.safe_to_retry,
            })
        }
    }

    #[test]
    fn unknown_blocks() {
        let calls = Arc::new(AtomicUsize::new(0));
        let rails: Vec<Box<dyn RailAdapter>> = vec![Box::new(StubRail {
            name: "a",
            status: RailStatus::Unknown,
            safe_to_retry: None,
            calls: calls.clone(),
        })];
        let c = Coordinator::new();
        let r = c.execute("i1", "k1", &rails).unwrap();
        assert_eq!(r.status, RailStatus::Unknown);
        let r2 = c.execute("i1", "k1", &rails).unwrap();
        assert_eq!(r2, r);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn wal_store_replays_after_reopen_without_resubmit() {
        let dir = std::env::temp_dir().join(format!("wal-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("records.jsonl");
        let calls = Arc::new(AtomicUsize::new(0));
        let first;
        {
            let store = Arc::new(WalRecordStore::open(&path).unwrap());
            let c = Coordinator::with_store(store);
            let rails: Vec<Box<dyn RailAdapter>> = vec![Box::new(StubRail {
                name: "a",
                status: RailStatus::Submitted,
                safe_to_retry: None,
                calls: calls.clone(),
            })];
            first = c.execute("i1", "k1", &rails).unwrap();
        } // simulate restart: coordinator and store dropped
        {
            let store = Arc::new(WalRecordStore::open(&path).unwrap());
            let c = Coordinator::with_store(store);
            let rails: Vec<Box<dyn RailAdapter>> = vec![Box::new(StubRail {
                name: "a",
                status: RailStatus::Submitted,
                safe_to_retry: None,
                calls: calls.clone(),
            })];
            let second = c.execute("i1", "k1", &rails).unwrap();
            assert_eq!(second, first);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn wal_store_first_writer_wins() {
        let dir = std::env::temp_dir().join(format!("wal-fww-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("records.jsonl");
        {
            let store = WalRecordStore::open(&path).unwrap();
            let winner = ResultRecord {
                idempotency_key: "k".into(),
                intent_id: "w".into(),
                rail: "winner".into(),
                status: RailStatus::Submitted,
                provider_ref: None,
                safe_to_retry: None,
            };
            let mut loser = winner.clone();
            loser.intent_id = "l".into();
            loser.rail = "loser".into();
            assert_eq!(store.put_if_absent(winner.clone()).unwrap(), winner);
            assert_eq!(store.put_if_absent(loser).unwrap(), winner);
        }
        let reopened = WalRecordStore::open(&path).unwrap();
        assert_eq!(reopened.get("k").unwrap().unwrap().rail, "winner");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn sanitize_rejects_separators() {
        assert!(sanitize("bad\tfield").is_err());
        assert!(sanitize("bad\nfield").is_err());
        assert!(sanitize("fine").is_ok());
    }
}
