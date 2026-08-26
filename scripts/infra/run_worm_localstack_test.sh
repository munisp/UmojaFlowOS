#!/usr/bin/env bash
set -euo pipefail

NAME="umoja-localstack-worm-${RANDOM}"
PORT="${LOCALSTACK_PORT:-4566}"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
docker run --rm -d --name "$NAME" -p "${PORT}:4566" -e SERVICES=s3 -e AWS_DEFAULT_REGION=us-east-1 localstack/localstack:3.8.1 >/dev/null
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${PORT}/_localstack/health" | grep -q '"s3"'; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:${PORT}/_localstack/health" | grep -q '"s3"'

export LOCALSTACK_URL="http://127.0.0.1:${PORT}"
export AWS_DEFAULT_REGION=us-east-1
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
pytest -q tests/infra/test_release_evidence_worm_localstack.py
