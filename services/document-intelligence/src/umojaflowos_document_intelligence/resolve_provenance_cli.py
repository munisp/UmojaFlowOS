"""Command-line entry point for selector-derived model provenance.

The TypeScript control plane invokes this to obtain the exact model tag, digest,
and role for an analysis job. Success prints a single JSON object on stdout.
Any failure prints a JSON object describing the fail-closed reason on stderr and
exits non-zero, so the control plane cannot proceed with unresolved provenance.

Usage:
  python -m umojaflowos_document_intelligence.resolve_provenance_cli <image|text>
"""

from __future__ import annotations

import asyncio
import json
import sys

from .provenance_resolver import ProvenanceUnavailable, resolve_model_provenance


def main(argv: list[str]) -> int:
    if len(argv) != 2 or argv[1] not in {"image", "text"}:
        print(json.dumps({"error": "usage: resolve_provenance_cli <image|text>"}), file=sys.stderr)
        return 2
    try:
        provenance = asyncio.run(resolve_model_provenance(argv[1]))  # type: ignore[arg-type]
    except ProvenanceUnavailable as exc:
        print(json.dumps({"error": str(exc), "failClosed": True}), file=sys.stderr)
        return 3
    print(json.dumps(provenance))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
