output "postgres_dsn" {
  value     = "postgres://${var.postgres_admin_user}:<redacted>@127.0.0.1:${var.postgres_port}/${var.postgres_database}?sslmode=disable"
  sensitive = true
}

output "kafka_broker" {
  value = "127.0.0.1:${var.kafka_port}"
}

output "tigerbeetle_address" {
  value = "127.0.0.1:${var.tigerbeetle_port}"
}

output "network" {
  value = docker_network.umoja.name
}
