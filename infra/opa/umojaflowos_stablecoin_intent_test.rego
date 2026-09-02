package umojaflowos.stablecoin

import rego.v1

valid_intent := {
  "tenant_id": "tenant-a",
  "intent_id": "intent-123",
  "idempotency_key": "idem-123",
  "asset": "USDC",
  "amount_minor": 1000000,
  "release_sha": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "reconciliation_run_id": "recovery-run-20260902",
  "provider_final": true,
  "business_effect": true,
}

test_valid_intent if {
  result := decision with input as valid_intent
  result.allow == true
  result.reason == "allow: validated stablecoin settlement intent"
}

test_invalid_release_sha_denied if {
  result := decision with input as object.union(valid_intent, {
    "release_sha": "not-a-release"
  })
  result.allow == false
  result.reason == "deny: invalid release SHA"
}

test_invalid_run_id_denied if {
  result := decision with input as object.union(valid_intent, {
    "reconciliation_run_id": "bad/run/id"
  })
  result.allow == false
  result.reason == "deny: invalid reconciliation run ID"
}

test_non_positive_amount_denied if {
  result := decision with input as object.union(valid_intent, {
    "amount_minor": 0
  })
  result.allow == false
  result.reason == "deny: amount must be positive"
}

test_unapproved_asset_denied if {
  result := decision with input as object.union(valid_intent, {
    "asset": "BTC"
  })
  result.allow == false
  result.reason == "deny: asset is not an approved stablecoin"
}

test_missing_identity_denied if {
  result := decision with input as object.union(valid_intent, {
    "tenant_id": ""
  })
  result.allow == false
  result.reason == "deny: identity bindings are required"
}

test_unconfirmed_finality_denied if {
  result := decision with input as object.union(valid_intent, {
    "provider_final": false
  })
  result.allow == false
  result.reason == "deny: provider finality and business effect are both required"
}

test_unconfirmed_business_effect_denied if {
  result := decision with input as object.union(valid_intent, {
    "business_effect": false
  })
  result.allow == false
  result.reason == "deny: provider finality and business effect are both required"
}

test_missing_fields_denied if {
  result := decision with input as {
    "tenant_id": "tenant-a"
  }
  result.allow == false
}
