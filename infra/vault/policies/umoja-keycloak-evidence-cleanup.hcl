# Separate cleanup identity for Vault KV v2 soft deletion only.
# This policy must not be attached to the rotation workflow identity.
path "secret/metadata/umoja/keycloak/evidence-publisher" {
  capabilities = ["read"]
}

path "secret/delete/umoja/keycloak/evidence-publisher" {
  capabilities = ["update"]
}

# Explicitly deny irreversible destruction, metadata deletion, and unrelated paths.
path "secret/destroy/umoja/keycloak/evidence-publisher" {
  capabilities = ["deny"]
}

path "secret/metadata/*" {
  capabilities = ["deny"]
}

path "secret/data/*" {
  capabilities = ["deny"]
}

path "secret/destroy/*" {
  capabilities = ["deny"]
}

path "sys/*" {
  capabilities = ["deny"]
}
