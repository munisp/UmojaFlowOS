#!/usr/bin/env python3
"""Validate and optionally send a non-production release-evidence failure event."""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import sys
import urllib.request
from pathlib import Path

SHA_RE = re.compile(r"^[a-f0-9]{40}$")


def payload(release_sha: str, run_id: str, workflow_run: str) -> dict[str, str]:
    if not SHA_RE.fullmatch(release_sha):
        raise ValueError("release_sha must be a lowercase 40-character Git SHA")
    if not run_id or any(char in run_id for char in "\r\n"):
        raise ValueError("run_id must be nonempty and single-line")
    if not workflow_run.startswith("https://"):
        raise ValueError("workflow_run must be an HTTPS URL")
    return {"event": "umoja_release_evidence_worm_failure", "release_sha": release_sha, "run_id": run_id, "workflow_run": workflow_run}


def pagerduty_event(event: dict[str, str], routing_key: str) -> dict:
    return {
        "routing_key": routing_key,
        "event_action": "trigger",
        "dedup_key": f"umoja-worm-{event['release_sha']}-{event['run_id']}",
        "payload": {
            "summary": "UmojaFlowOS WORM evidence publication failed",
            "source": "github-actions/UmojaFlowOS",
            "severity": "critical",
            "custom_details": event,
        },
    }


def slack_event(event: dict[str, str]) -> dict:
    return {
        "text": f"UmojaFlowOS WORM evidence publication failed for {event['release_sha']}",
        "blocks": [{"type": "section", "text": {"type": "mrkdwn", "text": ":rotating_light: *UmojaFlowOS WORM evidence failure*\\nRelease: `<sha>`\\nRun: `<url>`\\nDecision: *NO-GO*"}}],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release-sha", required=True)
    parser.add_argument("--run-id", required=True)
    parser.add_argument("--workflow-run", required=True)
    parser.add_argument("--url", help="Explicit non-production gateway URL; omitted for offline validation")
    parser.add_argument("--hmac-secret", help="Optional test-only HMAC secret; never use a production secret")
    parser.add_argument("--pagerduty-routing-key", default="synthetic-pagerduty-routing-key")
    parser.add_argument("--output-dir", type=Path, default=Path("/tmp/umoja-release-alert-test"))
    args = parser.parse_args()

    event = payload(args.release_sha, args.run_id, args.workflow_run)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    (args.output_dir / "github-event.json").write_text(json.dumps(event, indent=2) + "\n", encoding="utf-8")
    (args.output_dir / "pagerduty-event.json").write_text(json.dumps(pagerduty_event(event, args.pagerduty_routing_key), indent=2) + "\n", encoding="utf-8")
    (args.output_dir / "slack-event.json").write_text(json.dumps(slack_event(event), indent=2) + "\n", encoding="utf-8")

    body = json.dumps(event, separators=(",", ":")).encode()
    headers = {"content-type": "application/json", "user-agent": "umoja-release-alert-test/1"}
    if args.hmac_secret:
        headers["x-umoja-signature"] = hmac.new(args.hmac_secret.encode(), body, hashlib.sha256).hexdigest()
    if args.url:
        request = urllib.request.Request(args.url, data=body, headers=headers, method="POST")
        with urllib.request.urlopen(request, timeout=10) as response:
            if response.status < 200 or response.status >= 300:
                raise RuntimeError(f"gateway returned HTTP {response.status}")
        print(f"gateway response: HTTP {response.status}")
    else:
        print("offline payload validation: PASSED")
    print(f"payload={args.output_dir / 'github-event.json'}")
    print(f"pagerduty={args.output_dir / 'pagerduty-event.json'}")
    print(f"slack={args.output_dir / 'slack-event.json'}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print(f"release alert webhook test: FAILED: {error}", file=sys.stderr)
        raise SystemExit(1)
