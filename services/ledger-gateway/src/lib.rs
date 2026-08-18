use serde::{Deserialize, Serialize};
pub mod eventing;

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
