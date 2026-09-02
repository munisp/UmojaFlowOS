terraform {
  required_version = ">= 1.6.0"
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0"
    }
  }
}

provider "docker" {}

resource "docker_network" "umoja" {
  name = var.network_name
}

resource "docker_volume" "postgres" { name = "${var.name}-postgres" }
resource "docker_volume" "redpanda" { name = "${var.name}-redpanda" }
resource "docker_volume" "tigerbeetle" { name = "${var.name}-tigerbeetle" }

resource "docker_image" "postgres" {
  name         = var.postgres_image
  keep_locally = true
}
resource "docker_image" "redpanda" {
  name         = var.redpanda_image
  keep_locally = true
}
resource "docker_image" "tigerbeetle" {
  name         = var.tigerbeetle_image
  keep_locally = true
}

resource "docker_container" "postgres" {
  name  = "${var.name}-postgres"
  image = docker_image.postgres.image_id
  networks_advanced { name = docker_network.umoja.name }
  env = [
    "POSTGRES_USER=${var.postgres_admin_user}",
    "POSTGRES_PASSWORD=${var.postgres_admin_password}",
    "POSTGRES_DB=${var.postgres_database}",
  ]
  mounts { type = "volume"; source = docker_volume.postgres.name; target = "/var/lib/postgresql/data" }
  ports { internal = 5432; external = var.postgres_port }
  healthcheck {
    test         = ["CMD-SHELL", "pg_isready -U ${var.postgres_admin_user} -d ${var.postgres_database}"]
    interval     = "5s"
    timeout      = "3s"
    retries      = 20
    start_period = "10s"
  }
}

resource "docker_container" "redpanda" {
  name  = "${var.name}-redpanda"
  image = docker_image.redpanda.image_id
  command = [
    "redpanda", "start",
    "--overprovisioned", "--smp", "1", "--memory", "768M",
    "--reserve-memory", "0M", "--check=false",
    "--node-id", "0", "--kafka-addr", "internal://0.0.0.0:9092,external://0.0.0.0:19092",
    "--advertise-kafka-addr", "internal://${var.name}-redpanda:9092,external://localhost:19092",
    "--pandaproxy-addr", "internal://0.0.0.0:8082,external://0.0.0.0:18082",
    "--advertise-pandaproxy-addr", "internal://${var.name}-redpanda:8082,external://localhost:18082",
  ]
  networks_advanced { name = docker_network.umoja.name }
  mounts { type = "volume"; source = docker_volume.redpanda.name; target = "/var/lib/redpanda/data" }
  ports { internal = 19092; external = var.kafka_port }
  ports { internal = 18082; external = var.redpanda_admin_port }
  healthcheck {
    test         = ["CMD-SHELL", "rpk cluster health --brokers localhost:9092 | grep -q Healthy"]
    interval     = "5s"
    timeout      = "5s"
    retries      = 30
    start_period = "15s"
  }
}

# Development-only single replica. Production must use a separately reviewed
# multi-replica TigerBeetle topology with stable identity and quorum controls.
resource "null_resource" "format_tigerbeetle_data_file" {
  triggers = { volume = docker_volume.tigerbeetle.id, image = docker_image.tigerbeetle.image_id }
  provisioner "local-exec" {
    command = <<-EOT
      set -eu
      docker run --rm -v ${docker_volume.tigerbeetle.name}:/data ${docker_image.tigerbeetle.image_id} format --cluster=0 --replica=0 --replica-count=1 /data/0.tigerbeetle
    EOT
  }
}

resource "docker_container" "tigerbeetle" {
  name  = "${var.name}-tigerbeetle"
  image = docker_image.tigerbeetle.image_id
  command = ["start", "--addresses=0.0.0.0:3000", "/data/0.tigerbeetle"]
  networks_advanced { name = docker_network.umoja.name }
  mounts { type = "volume"; source = docker_volume.tigerbeetle.name; target = "/data" }
  ports { internal = 3000; external = var.tigerbeetle_port }
  depends_on = [docker_container.postgres, null_resource.format_tigerbeetle_data_file]
}

resource "null_resource" "create_topics" {
  triggers = { broker = docker_container.redpanda.id }
  provisioner "local-exec" {
    command = <<-EOT
      set -eu
      until docker exec ${docker_container.redpanda.name} rpk cluster health --brokers localhost:9092 >/dev/null 2>&1; do sleep 2; done
      for topic in ${join(" ", var.kafka_topics)}; do
        docker exec ${docker_container.redpanda.name} rpk topic create "$topic" --brokers localhost:9092 --partitions 12 --replicas 1 || true
      done
    EOT
  }
  depends_on = [docker_container.redpanda]
}

resource "null_resource" "apply_migration" {
  triggers = { postgres = docker_container.postgres.id }
  provisioner "local-exec" {
    command = <<-EOT
      set -eu
      until docker exec ${docker_container.postgres.name} pg_isready -U ${var.postgres_admin_user} -d ${var.postgres_database} >/dev/null 2>&1; do sleep 2; done
      PGPASSWORD='${var.postgres_admin_password}' psql 'host=127.0.0.1 port=${var.postgres_port} user=${var.postgres_admin_user} dbname=${var.postgres_database}' -v ON_ERROR_STOP=1 -f ../../../../database/postgresql/0058_native_stablecoin_intents_idempotency.sql
    EOT
  }
  depends_on = [docker_container.postgres]
}
