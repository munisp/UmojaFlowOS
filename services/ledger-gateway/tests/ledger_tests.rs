use ledger_gateway::{validate_balanced, Posting};

#[test]
fn accepts_balanced_same_currency_transfer() {
    let result = validate_balanced(&[
        Posting {
            account_id: "customer_ngn".into(),
            currency: "NGN".into(),
            debit_minor: 100,
            credit_minor: 0,
        },
        Posting {
            account_id: "settlement_ngn".into(),
            currency: "NGN".into(),
            debit_minor: 0,
            credit_minor: 100,
        },
    ]);
    assert!(result.is_ok());
}

#[test]
fn rejects_unbalanced_transfer() {
    let result = validate_balanced(&[Posting {
        account_id: "customer_ngn".into(),
        currency: "NGN".into(),
        debit_minor: 100,
        credit_minor: 0,
    }]);
    assert!(result.is_err());
}
