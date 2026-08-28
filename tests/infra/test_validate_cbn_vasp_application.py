from __future__ import annotations

import copy
import json
from pathlib import Path

from scripts.infra.validate_cbn_vasp_application import semantic_errors, validate_schema

ROOT = Path(__file__).resolve().parents[2]


def document_ref(name: str, owner: str = "owner-a", reviewer: str = "reviewer-a"):
    return {"id": name, "title": name, "uri": f"https://evidence.example/{name}.pdf", "sha256": "a" * 64, "owner_subject": owner, "reviewer_subject": reviewer, "version": "v1", "issued_at": "2026-08-28T00:00:00Z"}


def dossier():
    return {"schema_version":"1.0","dossier_id":"dossier-001","applicant":{"legal_name":"Umoja Holdings Limited","incorporation_country":"NG","registered_address":"Lagos, Nigeria","nigeria_connection":"Nigerian incorporated applicant","ownership_document_ref":document_ref("ownership"),"regulatory_perimeter_document_ref":document_ref("perimeter"),"authorised_signatory_subject":"signatory-1"},"innovation":{"title":"Governed virtual asset payment controls","track":"vasp","problem":"Controlled payment risk","market_benefit":"Lower operational risk","in_scope_capabilities":["compliance monitoring"],"excluded_capabilities":["custody"],"partner_operated_capabilities":["authorised settlement"],"legal_boundary_ref":document_ref("boundary")},"test_reference":document_ref("test-plan"),"documents":[document_ref("risk")],"declarations":{"no_license_claim":True,"no_fabricated_external_evidence":True,"board_approval_ref":document_ref("board"),"approved_at":"2026-08-28T00:00:00Z"}}


def governance():
    roles = ["compliance_mlro","security","product_risk","treasury_custody","consumer_protection","incident_commander_cbn_liaison"]
    officers=[]
    for i, role in enumerate(roles):
        officers.append({"role":role,"primary_subject":f"primary-{i}","alternate_subject":f"alternate-{i}","appointment_ref":document_ref(f"appointment-{i}"),"training_ref":document_ref(f"training-{i}"),"conflict_declaration_ref":document_ref(f"conflict-{i}"),"recusal_rules_ref":document_ref(f"recusal-{i}")})
    return {"schema_version":"1.0","dossier_id":"dossier-001","officers":officers,"authority_matrix":[{"decision":"test-limit change","permitted_roles":["product_risk","compliance_mlro"],"dual_control":True,"prohibited_self_approval":True,"audit_event_type":"test_limit_change"}],"access_governance":{"mfa_required_for_privileged_access":True,"last_access_review_ref":document_ref("access"),"departed_user_review_ref":document_ref("departed"),"privileged_role_roster_ref":document_ref("roster")},"approvals":[{"approval_type":"board_management","approver_subject":"board-1","approved_at":"2026-08-28T00:00:00Z","document_ref":document_ref("board-governance")},{"approval_type":"policy_governance","approver_subject":"policy-1","approved_at":"2026-08-28T00:00:00Z","document_ref":document_ref("policy-governance")}]}


def test_valid_dossier_and_governance_contracts():
    d, g = dossier(), governance()
    ds = json.loads((ROOT / "assurance/cbn_vasp_application_dossier.schema.json").read_text())
    gs = json.loads((ROOT / "assurance/cbn_vasp_governance.schema.json").read_text())
    assert validate_schema(d, ds, "dossier") == []
    assert validate_schema(g, gs, "governance") == []
    assert semantic_errors(d, g) == []


def test_dossier_id_mismatch_is_rejected():
    d, g = dossier(), governance(); g["dossier_id"] = "other"
    assert "governance.dossier_id must equal dossier.dossier_id" in semantic_errors(d, g)


def test_placeholder_and_self_review_are_rejected():
    d, g = dossier(), governance(); d["applicant"]["legal_name"] = "REPLACE_WITH_LEGAL_NAME"
    d["applicant"]["ownership_document_ref"]["reviewer_subject"] = d["applicant"]["ownership_document_ref"]["owner_subject"]
    errors = semantic_errors(d, g)
    assert any("placeholder" in error for error in errors)
    assert any("owner and reviewer" in error for error in errors)


def test_duplicate_officer_subject_is_rejected():
    d, g = dossier(), governance(); g["officers"][1]["primary_subject"] = g["officers"][0]["primary_subject"]
    assert any("all primary and alternate subjects must be distinct" in error for error in semantic_errors(d, g))
