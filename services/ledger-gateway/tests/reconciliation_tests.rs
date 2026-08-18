use ledger_gateway::{
    verify_projection, ConfirmedTransferFact, PostgresProjectionRecord, ReconciliationError,
};

fn fact() -> ConfirmedTransferFact {
    ConfirmedTransferFact {
        transfer_id: 1,
        correlation_id: "corr-1".into(),
        currency: "ZAR".into(),
        amount_minor: 100,
        posted_at_rfc3339: "2026-08-18T00:00:00Z".into(),
    }
}

#[test]
fn reconciles_matching_confirmed_fact_and_projection() {
    let projection = PostgresProjectionRecord {
        transfer_id: 1,
        correlation_id: "corr-1".into(),
        currency: "ZAR".into(),
        amount_minor: 100,
        projected_at_rfc3339: "2026-08-18T00:00:01Z".into(),
    };
    assert_eq!(verify_projection(&fact(), &projection), Ok(()));
}

#[test]
fn rejects_mismatched_projection() {
    let projection = PostgresProjectionRecord {
        transfer_id: 1,
        correlation_id: "corr-1".into(),
        currency: "ZAR".into(),
        amount_minor: 99,
        projected_at_rfc3339: "2026-08-18T00:00:01Z".into(),
    };
    assert_eq!(
        verify_projection(&fact(), &projection),
        Err(ReconciliationError::Mismatch)
    );
}
