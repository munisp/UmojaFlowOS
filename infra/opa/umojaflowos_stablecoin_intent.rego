package umojaflowos.stablecoin

import rego.v1

default allow := false
default reason := "policy decision unavailable"

valid_release if {
  regex.match("^[a-f0-9]{40}$", input.release_sha)
}

valid_run if {
  regex.match("^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$", input.reconciliation_run_id)
}

valid_amount if input.amount_minor > 0
valid_asset if input.asset in {"USDC", "USDT"}
valid_identity if input.tenant_id != ""; input.intent_id != ""; input.idempotency_key != ""
valid_finality if input.provider_final == true; input.business_effect == true

allow if {
  valid_release
  valid_run
  valid_amount
  valid_asset
  valid_identity
  valid_finality
}

reason := "allow: validated stablecoin settlement intent" if allow
reason := "deny: invalid release SHA" if not valid_release
reason := "deny: invalid reconciliation run ID" if valid_release; not valid_run
reason := "deny: amount must be positive" if valid_release; valid_run; not valid_amount
reason := "deny: asset is not an approved stablecoin" if valid_release; valid_run; valid_amount; not valid_asset
reason := "deny: identity bindings are required" if valid_release; valid_run; valid_amount; valid_asset; not valid_identity
reason := "deny: provider finality and business effect are both required" if valid_release; valid_run; valid_amount; valid_asset; valid_identity; not valid_finality

result := {"allow": allow, "reason": reason}
