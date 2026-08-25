#!/usr/bin/env python3
"""Verify a local UmojaFlowOS VASP evidence manifest before platform intake.

This checks local file integrity and workflow segregation. It does not determine
whether the evidence is legally sufficient or whether a regulator/provider has
approved anything; those are independent reviewer decisions.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

AREAS = {
    "controlled_live_test": (7, {"testPlan", "boundedLimits", "sandboxInteroperability", "reconciliationExercise", "windDownExercise"}),
    "governance_legal_ownership": (8, {"legalEntityAndUbo", "officerAppointments", "boardApprovals", "accessReview"}),
    "aml_cft_cpf_operations": (14, {"approvedProgramme", "lawfulScreeningSource", "caseExercises", "mlroAndTraining", "travelRuleTest", "reportingDecisionProcess"}),
    "customer_asset_safeguarding": (13, {"approvedScope", "keyManagement", "segregationAndReconciliation", "reserveOrNotApplicable", "windDown"}),
    "cybersecurity_resilience": (10, {"mfaAndAccessReview", "secretsAndCertificates", "independentSecurityTest", "monitoringAndOnCall", "backupAndDr", "measuredSlo"}),
    "consumer_incident_reporting": (6, {"consumerJourney", "complaintExercise", "incidentExercise", "authorisedChannelReceipt", "retentionAndSignatory"}),
}


def fail(message: str) -> None:
    print(f"manifest verification failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def https(value: str) -> bool:
    parsed = urlparse(value)
    return parsed.scheme == "https" and bool(parsed.netloc)


def verify_artifact(item: dict, key: str) -> None:
    artifact = item.get(key)
    if not isinstance(artifact, dict):
        fail(f"{item.get('area')}: missing {key}")
    path = Path(str(artifact.get("path", ""))).expanduser()
    if not path.is_file():
        fail(f"{item.get('area')}: {key}.path is not a readable file: {path}")
    if not https(str(artifact.get("uri", ""))):
        fail(f"{item.get('area')}: {key}.uri must be HTTPS")
    expected = str(artifact.get("sha256", ""))
    actual = sha256(path)
    if expected != actual:
        fail(f"{item.get('area')}: {key} SHA-256 mismatch; expected {expected}, calculated {actual}")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest", type=Path)
    parser.add_argument("--require-attestation", action="store_true")
    arguments = parser.parse_args()
    document = json.loads(arguments.manifest.read_text(encoding="utf-8"))
    dossier = document.get("dossier", {})
    if dossier.get("track") != "vasp":
        fail("dossier.track must be vasp")
    for prohibited in ("externalSubmissionClaimed", "cbnAdmissionClaimed", "licenceClaimed"):
        if dossier.get(prohibited) is not False:
            fail(f"dossier.{prohibited} must remain false")
    items = document.get("items")
    if not isinstance(items, list) or len(items) != len(AREAS):
        fail("manifest must contain exactly six readiness items")
    seen: set[str] = set()
    total = 0
    for item in items:
        area = item.get("area")
        if area not in AREAS or area in seen:
            fail(f"unsupported or duplicate area: {area}")
        seen.add(area)
        points, acceptance_keys = AREAS[area]
        if item.get("maxPoints") != points:
            fail(f"{area}: maxPoints must be {points}")
        total += points
        submitter = str(item.get("submitterSubject", ""))
        if not submitter or submitter.startswith("<"):
            fail(f"{area}: submitterSubject must identify a real platform subject")
        acceptance = item.get("acceptance", {})
        if not isinstance(acceptance, dict) or {key for key, value in acceptance.items() if value is True} != acceptance_keys:
            fail(f"{area}: acceptance must set exactly the required criteria to true")
        verify_artifact(item, "evidence")
        attestation = item.get("attestation")
        if arguments.require_attestation:
            verify_artifact(item, "attestation")
            verifier_subject = str(attestation.get("platformVerifierSubject", ""))
            if not verifier_subject or verifier_subject == submitter or verifier_subject.startswith("<"):
                fail(f"{area}: platform verifier must be a different real subject from the submitter")
            if not str(attestation.get("externalVerifier", "")).strip() or str(attestation.get("externalVerifier")).startswith("<"):
                fail(f"{area}: externalVerifier is required")
            if len(str(attestation.get("rationale", "")).strip()) < 20 or str(attestation.get("rationale")).startswith("<"):
                fail(f"{area}: a real independent rationale of at least 20 characters is required")
    if seen != set(AREAS) or total != 58:
        fail("manifest must cover all six areas totalling 58 points")
    print(f"verified local evidence manifest: 6 areas, {total} points, attestation_required={arguments.require_attestation}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
