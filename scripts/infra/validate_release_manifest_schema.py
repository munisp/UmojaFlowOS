#!/usr/bin/env python3
"""Validate a release manifest against the strict repository JSON Schema."""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--schema", default=Path("assurance/release_evidence_manifest.schema.json"), type=Path)
    args = parser.parse_args()

    try:
        schema = json.loads(args.schema.read_text(encoding="utf-8"))
        manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        print(f"manifest schema validation: FAILED: {error}", file=sys.stderr)
        return 1

    validator = Draft202012Validator(schema, format_checker=FormatChecker())
    errors = sorted(validator.iter_errors(manifest), key=lambda error: (list(error.absolute_path), error.message))
    if errors:
        for error in errors:
            path = "$"
            for component in error.absolute_path:
                path += f"[{component!r}]" if isinstance(component, int) else f".{component}"
            print(f"manifest schema validation: FAILED: {path}: {error.message}", file=sys.stderr)
        return 1
    print(f"manifest schema validation: PASSED ({args.manifest})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
