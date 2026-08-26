#!/usr/bin/env bash
# Offline validation of all retention monitoring configuration.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROMTOOL_BIN="${PROMTOOL_BIN:-promtool}"
AMTOOL_BIN="${AMTOOL_BIN:-amtool}"
ALERTMANAGER_FILE="$ROOT/infra/retention-gateway/alertmanager-production-pagerduty-lockwait.yml"
SERVICE_MONITOR_FILE="$ROOT/infra/retention-gateway/synthetic-monitor/prometheus-operator.yaml"
SERVICE_FILE="$ROOT/infra/retention-gateway/synthetic-monitor/kubernetes.yaml"

require_binary() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "required binary not found: $1" >&2
    exit 127
  }
}

require_binary "$PROMTOOL_BIN"
require_binary "$AMTOOL_BIN"

mapfile -t RULE_FILES < <(
  python3 - "$ROOT/infra" <<'PY'
from pathlib import Path
import sys
import yaml
for path in sorted(Path(sys.argv[1]).rglob("*.y*ml")):
    try:
        docs = list(yaml.safe_load_all(path.read_text()))
    except yaml.YAMLError:
        continue
    if any(isinstance(doc, dict) and "groups" in doc for doc in docs):
        print(path)
PY
)

if [ "${#RULE_FILES[@]}" -eq 0 ]; then
  echo "no Prometheus rule files discovered" >&2
  exit 1
fi

for rule_file in "${RULE_FILES[@]}"; do
  echo "Checking Prometheus rule syntax: $rule_file"
  "$PROMTOOL_BIN" check rules "$rule_file"
done

echo "Checking Alertmanager syntax: $ALERTMANAGER_FILE"
"$AMTOOL_BIN" check-config "$ALERTMANAGER_FILE"

assert_route() {
  local expected_receiver="$1"
  shift
  local output
  output="$("$AMTOOL_BIN" config routes test --config.file "$ALERTMANAGER_FILE" "$@")"
  printf '%s\n' "$output"
  tr ',' '\n' <<<"$output" | grep -Fqx "$expected_receiver" || {
    echo "expected receiver '$expected_receiver' was not selected" >&2
    exit 1
  }
}

synthetic_labels=(
  'alertname=UmojaRetentionSyntheticCircuitOpenObserved'
  'service=retention-delete-worker'
  'environment=production'
  'urgency=page'
  'team=engineering'
)
assert_route pagerduty-retention-postgres-critical "${synthetic_labels[@]}"
assert_route webhook-retention-engineering "${synthetic_labels[@]}"

python3 - "$SERVICE_MONITOR_FILE" "$SERVICE_FILE" <<'PY'
from pathlib import Path
import sys
import yaml

monitor_docs = list(yaml.safe_load_all(Path(sys.argv[1]).read_text()))
service_docs = list(yaml.safe_load_all(Path(sys.argv[2]).read_text()))
service_monitor = next(doc for doc in monitor_docs if doc and doc.get("kind") == "ServiceMonitor")
prometheus_rule = next(doc for doc in monitor_docs if doc and doc.get("kind") == "PrometheusRule")
service = next(doc for doc in service_docs if doc and doc.get("kind") == "Service")
assert service_monitor["spec"]["selector"]["matchLabels"] == service["metadata"]["labels"]
endpoint = service_monitor["spec"]["endpoints"][0]
assert endpoint["port"] == service["spec"]["ports"][0]["name"]
assert any(group["name"] == "umoja-retention-synthetic-circuit-recording" for group in prometheus_rule["spec"]["groups"])
assert any(group["name"] == "umoja-retention-synthetic-circuit-alerts" for group in prometheus_rule["spec"]["groups"])
print("ServiceMonitor and PrometheusRule wiring: valid")
PY

echo "retention monitoring CI validation: passed"
