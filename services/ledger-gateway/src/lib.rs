use serde::{Deserialize, Serialize};
pub mod eventing;
pub mod multirail_failover;
pub mod yellowcard_adapter;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Posting {
    pub account_id: String,
    pub currency: String,
    pub debit_minor: i128,
    pub credit_minor: i128,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum LedgerError {
    EmptyPostingSet,
    MissingAccount,
    MissingCurrency,
    NegativeAmount,
    Unbalanced { currency: String, net_minor: i128 },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ConfirmedTransferFact {
    pub transfer_id: u64,
    pub correlation_id: String,
    pub currency: String,
    pub amount_minor: u64,
    pub posted_at_rfc3339: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PostgresProjectionRecord {
    pub transfer_id: u64,
    pub correlation_id: String,
    pub currency: String,
    pub amount_minor: u64,
    pub projected_at_rfc3339: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconciliationError {
    IncompleteConfirmedFact,
    IncompleteProjection,
    Mismatch,
}

pub fn verify_projection(
    fact: &ConfirmedTransferFact,
    projection: &PostgresProjectionRecord,
) -> Result<(), ReconciliationError> {
    if fact.transfer_id == 0
        || fact.correlation_id.trim().is_empty()
        || fact.currency.trim().is_empty()
        || fact.amount_minor == 0
        || fact.posted_at_rfc3339.trim().is_empty()
    {
        return Err(ReconciliationError::IncompleteConfirmedFact);
    }
    if projection.transfer_id == 0
        || projection.correlation_id.trim().is_empty()
        || projection.currency.trim().is_empty()
        || projection.amount_minor == 0
        || projection.projected_at_rfc3339.trim().is_empty()
    {
        return Err(ReconciliationError::IncompleteProjection);
    }
    if fact.transfer_id != projection.transfer_id
        || fact.correlation_id != projection.correlation_id
        || fact.currency != projection.currency
        || fact.amount_minor != projection.amount_minor
    {
        return Err(ReconciliationError::Mismatch);
    }
    Ok(())
}

pub fn validate_balanced(postings: &[Posting]) -> Result<(), LedgerError> {
    if postings.is_empty() {
        return Err(LedgerError::EmptyPostingSet);
    }
    let mut balances: std::collections::BTreeMap<&str, i128> = std::collections::BTreeMap::new();
    for posting in postings {
        if posting.account_id.trim().is_empty() {
            return Err(LedgerError::MissingAccount);
        }
        if posting.currency.trim().is_empty() {
            return Err(LedgerError::MissingCurrency);
        }
        if posting.debit_minor < 0 || posting.credit_minor < 0 {
            return Err(LedgerError::NegativeAmount);
        }
        *balances.entry(&posting.currency).or_default() +=
            posting.debit_minor - posting.credit_minor;
    }
    for (currency, net_minor) in balances {
        if net_minor != 0 {
            return Err(LedgerError::Unbalanced {
                currency: currency.to_owned(),
                net_minor,
            });
        }
    }
    Ok(())
}
