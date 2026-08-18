#!/usr/bin/env python3
"""Validate the evidence-only Ollama request path with a synthetic image.

This deliberately does NOT use a KYC or KYB document. It generates a plain
rectangle with a printed label locally, so the request exercises the
schema-constrained, evidence-only response contract without any identity data
and without producing any verification decision.

Success criteria:
  * The response parses as JSON and matches the requested schema exactly.
  * The disposition is confined to the evidence-only enum.
  * No approval-shaped field appears anywhere in the response.
"""

from __future__ import annotations

import base64
import io
import json
import os
import sys
import urllib.error
import urllib.request

from PIL import Image, ImageDraw

ENDPOINT = os.environ.get("OLLAMA_PRIVATE_ENDPOINT", "http://127.0.0.1:11434")
MODEL_TAG = "qwen3-vl:8b"

# The evidence-only response contract. There is intentionally no field that could
# express an approval, a match, or an identity determination.
RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "observed_text_present": {"type": "boolean"},
        "structural_observations": {"type": "array", "items": {"type": "string"}},
        "disposition": {"type": "string", "enum": ["review_required", "insufficient_evidence"]},
    },
    "required": ["observed_text_present", "structural_observations", "disposition"],
}

PROHIBITED_FIELDS = ("approved", "verified", "identity_match", "match", "decision", "authentic")


def synthetic_image_base64() -> str:
    image = Image.new("RGB", (420, 260), "white")
    draw = ImageDraw.Draw(image)
    draw.rectangle([10, 10, 410, 250], outline="black", width=3)
    draw.text((30, 60), "SYNTHETIC TEST CARD", fill="black")
    draw.text((30, 100), "NOT A REAL DOCUMENT", fill="black")
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return base64.b64encode(buffer.getvalue()).decode()


def request_evidence() -> dict:
    payload = {
        "model": MODEL_TAG,
        "prompt": (
            "List only structural observations about this image. Do not make any identity, "
            "authenticity, or verification determination. Reply using the provided JSON schema. "
            "The disposition must be review_required or insufficient_evidence."
        ),
        "images": [synthetic_image_base64()],
        "format": RESPONSE_SCHEMA,
        "stream": False,
        "options": {"temperature": 0, "num_predict": 256},
    }
    request = urllib.request.Request(
        f"{ENDPOINT.rstrip('/')}/api/generate",
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=900) as response:
            return json.loads(response.read().decode())
    except urllib.error.HTTPError as error:
        detail = error.read().decode(errors="replace")[:600]
        print(f"FAILED: runtime returned HTTP {error.code}: {detail}", file=sys.stderr)
        raise SystemExit(1) from error


def main() -> int:
    body = request_evidence()
    raw = body.get("response", "")
    try:
        parsed = json.loads(raw)
    except json.JSONDecodeError as error:
        print(f"FAILED: response was not valid JSON: {error}: {raw[:300]!r}", file=sys.stderr)
        return 1

    missing = [key for key in RESPONSE_SCHEMA["required"] if key not in parsed]
    if missing:
        print(f"FAILED: response omitted required fields {missing}", file=sys.stderr)
        return 1
    if parsed["disposition"] not in {"review_required", "insufficient_evidence"}:
        print(f"FAILED: disposition {parsed['disposition']!r} is outside the evidence-only enum", file=sys.stderr)
        return 1
    lowered = json.dumps(parsed).lower()
    present = [field for field in PROHIBITED_FIELDS if f'"{field}"' in lowered]
    if present:
        print(f"FAILED: response contained decision-shaped fields {present}", file=sys.stderr)
        return 1

    print(f"model={body.get('model')} endpoint={ENDPOINT}")
    print(f"disposition={parsed['disposition']} observations={len(parsed['structural_observations'])}")
    print("Evidence-only contract satisfied: no determination, no approval field, schema-conformant.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
