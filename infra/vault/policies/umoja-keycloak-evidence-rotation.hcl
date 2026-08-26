# Vault JWT role policy for the protected rotation workflow.
# Mount names are deployment variables; this policy assumes KV v2 at `secret/`.

path "secret/data/umoja/keycloak/admin" {
  capabilities = ["read"]
}

path "secret/data/umoja/keycloak/evidence-publisher" {
  capabilities = ["create", "read", "update"]
}

path "secret/metadata/umoja/keycloak/evidence-publisher" {
  capabilities = ["read"]
}

# Explicitly prevent access to unrelated secrets and destructive Vault operations.
path "secret/data/*" {
  capabilities = ["deny"]
}

path "sys/*" {
  capabilities = ["deny"]
}
