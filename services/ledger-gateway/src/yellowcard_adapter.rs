#[derive(Clone, Debug, PartialEq, Eq)]
pub enum NormalizedStatus {
    Submitted,
    Pending,
    Settled,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct YellowCardResult {
    pub reference: String,
    pub sequence_id: String,
    pub status: NormalizedStatus,
    pub retryable_without_business_effect: bool,
    pub reason: String,
}

// Yellow Card statuses are intentionally mapped conservatively. Generic
// failures remain UNKNOWN because a failure response alone does not prove that
// no business effect occurred.
pub fn normalize_yellowcard_status(reference: String, sequence_id: String, raw: &str) -> YellowCardResult {
    let value = raw.trim().to_ascii_lowercase();
    match value.as_str() {
        "complete" | "completed" | "settled" | "success" | "successful" => YellowCardResult { reference, sequence_id, status: NormalizedStatus::Settled, retryable_without_business_effect: false, reason: "Yellow Card independently reported a completed send".into() },
        "created" | "accepted" | "processing" | "pending" | "in_progress" | "awaiting_approval" => YellowCardResult { reference, sequence_id, status: NormalizedStatus::Pending, retryable_without_business_effect: false, reason: "Yellow Card send remains provisional".into() },
        "expired" | "cancelled" | "canceled" | "rejected" => YellowCardResult { reference, sequence_id, status: NormalizedStatus::Failed, retryable_without_business_effect: true, reason: "Yellow Card explicitly reported a non-executed send".into() },
        _ => YellowCardResult { reference, sequence_id, status: NormalizedStatus::Unknown, retryable_without_business_effect: false, reason: "Yellow Card status is not safe to classify".into() },
    }
}
