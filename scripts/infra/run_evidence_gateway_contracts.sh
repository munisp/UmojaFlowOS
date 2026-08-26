#!/usr/bin/env bash
set -euo pipefail

COMPOSE_FILE="infra/evidence-gateway/compose.yaml"
PROJECT="umoja-evidence-gateway-contracts"
cleanup() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker compose -f "$COMPOSE_FILE" config >/dev/null
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build
for _ in $(seq 1 60); do
  if curl -fsS http://127.0.0.1:8280/healthz >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS http://127.0.0.1:8280/healthz >/dev/null
EVIDENCE_GATEWAY_URL=http://127.0.0.1:8280 \
KEYCLOAK_URL=http://127.0.0.1:8180 \
pytest -q tests/evidence_gateway/test_gateway_contract.py
