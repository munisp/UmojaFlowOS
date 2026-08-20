package umojaflowos.gateway

import rego.v1

default result := {"allow": false, "reason": "policy decision unavailable", "status_code": 403}

result := {"allow": true} if {
  is_read_method
  has_platform_role
}

result := {"allow": true} if {
  is_write_method
  has_privileged_role
}

is_read_method if input.request.method in {"GET", "HEAD", "OPTIONS"}
is_write_method if input.request.method in {"POST", "PUT", "PATCH", "DELETE"}

authorization := input.request.headers.authorization
token := split(authorization, " ")[1]
decoded := io.jwt.decode(token)
claims := decoded[1]
roles := object.get(object.get(claims, "realm_access", {}), "roles", [])

has_platform_role if roles[_] in {"umojaflowos_admin", "umojaflowos_compliance_officer", "umojaflowos_treasury_operator", "umojaflowos_auditor", "provider_contact", "cbn_liaison", "trade_sponsor", "procurement_owner", "trade_finance_operator", "supplier_representative", "authorised_dealer_liaison", "reconciliation_reviewer"}
has_privileged_role if roles[_] in {"umojaflowos_admin", "umojaflowos_compliance_officer", "umojaflowos_treasury_operator", "trade_sponsor", "procurement_owner", "trade_finance_operator", "authorised_dealer_liaison"}
