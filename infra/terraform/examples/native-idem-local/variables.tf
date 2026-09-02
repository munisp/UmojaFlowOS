variable "name" {
  type    = string
  default = "umoja-native-idem"
}

variable "network_name" {
  type    = string
  default = "umoja-native-idem-net"
}

variable "postgres_image" {
  type    = string
  default = "postgres:16.4-bookworm"
}

variable "redpanda_image" {
  type    = string
  default = "redpandadata/redpanda:v24.3.6"
}

variable "tigerbeetle_image" {
  type        = string
  description = "Pinned TigerBeetle image tag or digest approved by the platform toolchain."
  default     = "tigerbeetle/tigerbeetle:latest"
}

variable "postgres_admin_user" {
  type      = string
  default   = "postgres"
  sensitive = true
}

variable "postgres_admin_password" {
  type      = string
  sensitive = true
}

variable "postgres_database" {
  type    = string
  default = "umoja"
}

variable "postgres_port" {
  type    = number
  default = 55432
}

variable "kafka_port" {
  type    = number
  default = 19092
}

variable "redpanda_admin_port" {
  type    = number
  default = 18082
}

variable "tigerbeetle_port" {
  type    = number
  default = 3000
}

variable "kafka_topics" {
  type = list(string)
  default = [
    "umoja.stablecoin.v1.intent-created",
    "umoja.stablecoin.v1.provider-observed",
    "umoja.stablecoin.v1.finality-confirmed",
    "umoja.reconciliation.v1.unknown-created",
    "umoja.reconciliation.v1.decision-recorded",
    "umoja.compliance.v1.audit-event",
    "umoja.fabric.v1.attestation-requested",
  ]
}
