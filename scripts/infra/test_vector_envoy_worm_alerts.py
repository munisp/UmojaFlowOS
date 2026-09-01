#!/usr/bin/env python3
from __future__ import annotations

from pathlib import Path
import yaml

path = Path(__file__).parents[2] / "infra/monitoring/vector-envoy-worm-alerts.yml"
doc = yaml.safe_load(path.read_text())
rules = [rule for group in doc.get("groups", []) for rule in group.get("rules", [])]
assert len(rules) == 11, f"expected 11 alerts, got {len(rules)}"
names = [rule.get("alert") for rule in rules]
assert len(names) == len(set(names)), "duplicate alert names"
for rule in rules:
    assert rule.get("expr"), f"missing expression: {rule.get('alert')}"
    assert rule.get("for"), f"missing duration: {rule.get('alert')}"
    labels = rule.get("labels", {})
    assert labels.get("severity") in {"warning", "critical"}, f"invalid severity: {rule.get('alert')}"
    assert labels.get("service") == "vector-envoy-archive", f"missing service label: {rule.get('alert')}"
    assert rule.get("annotations", {}).get("runbook_url"), f"missing runbook: {rule.get('alert')}"
text = path.read_text()
for needle in ("vector_buffer_size_bytes", "node_filesystem_avail_bytes", "vector_component_discarded_events_total", "vector_component_errors_total", "vector_component_sent_events_total"):
    assert needle in text, needle
print(f"PASS: {len(rules)} Vector archive alert rules validated")
