# CBN VASP Sandbox: Final Submission Checklist

This checklist must be completed by the Compliance and Security owners before the dossier is submitted to the CBN Sandbox Portal.

## 1. Corporate & Identity (P0-01, P0-02)
- [ ] **Applicant Entity:** Verified legal name and Nigerian incorporation connection.
- [ ] **Authorised Signatory:** Named individual with board-delegated authority to sign the Sandbox Testing Agreement.
- [ ] **Ownership/UBO:** Full disclosure of ultimate beneficial owners and directors.
- [ ] **Product Boundary:** Signed statement explicitly excluding unlicensed custody, issuance, and exchange.

## 2. Governance & Accountability (P0-03)
- [ ] **Officer Roster:** Six distinct individuals assigned as primaries and alternates for all accountable roles.
- [ ] **Segregation of Duties:** No individual holds more than one role; document owners and reviewers are distinct.
- [ ] **Appointment & Training:** Hashed appointment letters and training acknowledgments for all twelve subjects (6 primary + 6 alternate).
- [ ] **Conflict Declarations:** Signed and hashed declarations for all officers.
- [ ] **Authority Matrix:** Dual-control matrix for test-limit changes and counterparty onboarding.

## 3. Staging Evidence (P1-01 to P1-09)
- [ ] **E-01 Build Provenance:** Cryptographically signed release tag and SLSA provenance attestation.
- [ ] **E-02 Schema Gate:** Validated PostgreSQL migration state and reconciliation column parity.
- [ ] **E-03 Identity Rotation:** Proof of successful Keycloak secret rotation and induced-failure recovery.
- [ ] **E-04 Ledger Validation:** Zero unexplained discrepancies in TigerBeetle-to-PostgreSQL reconciliation.
- [ ] **E-05 AML/Screening:** Real provider cases (hit/clear/false-positive) with analyst disposition.
- [ ] **E-06 Rollback Proof:** Evidence of successful deployment rollback and data restore from backup.
- [ ] **E-07 Alert Delivery:** End-to-end delivery trace of a critical alert to PagerDuty/Wazuh.
- [ ] **E-08 Resilience/Chaos:** Captured results of network partition, consensus loss, and pool exhaustion tests.
- [ ] **E-09 Verification:** Final independent verification report for all E-01 through E-08 artifacts.

## 4. Final Validation & Integrity
- [ ] **No Placeholders:** `validate_cbn_vasp_application.py` returns success with zero "REPLACE_WITH" or "TODO" errors.
- [ ] **HTTPS Evidence:** All evidence URIs use the secure protocol and point to the immutable WORM repository.
- [ ] **SHA-256 Parity:** All hashes in the JSON dossier match the `sha256sum` of the actual artifacts.
- [ ] **Board Approval:** Board resolution specifically approving the CBN application and the controlled-live test plan.

## 5. Declarations
- [ ] **No License Claim:** Explicitly declared `no_license_claim: true`.
- [ ] **No Fabrication:** Explicitly declared `no_fabricated_external_evidence: true`.

---
**Status:** [ ] READY FOR SUBMISSION | [X] INCOMPLETE (PENDING PRODUCTION DATA)
