"""Non-authoritative enterprise-governance reporting contract.

The module summarizes immutable records supplied by the control plane. It cannot
quote liquidity, make credit decisions, instruct a bank, issue a card, transfer
stablecoins, fund a receivable, or assert settlement.
"""
from collections import Counter


def summarize_enterprise_governance(records: list[dict]) -> dict:
    module_counts = Counter(str(record.get("module_kind", "unavailable")) for record in records)
    review_counts = Counter(str(record.get("review_status", "unreviewed")) for record in records)
    return {
        "record_count": len(records),
        "module_counts": dict(sorted(module_counts.items())),
        "review_counts": dict(sorted(review_counts.items())),
        "bank_instruction_created": False,
        "stablecoin_transfer_initiated": False,
        "credit_decision_made": False,
        "funding_initiated": False,
        "card_issued": False,
        "card_authorisation_initiated": False,
        "settlement_asserted": False,
        "authoritative_for_execution": False,
    }


def summarize_control_assurance(records: list[dict]) -> dict:
    """Summarize supplied assurance evidence without producing operational authority."""
    finding_counts = Counter(str(record.get("finding_code", "unavailable")) for record in records)
    status_counts = Counter(str(record.get("status", "unavailable")) for record in records)
    missing = sorted(code for code in finding_counts if code not in {"", "none", "resolved"})
    return {
        "assessment_count": len(records),
        "finding_counts": dict(sorted(finding_counts.items())),
        "status_counts": dict(sorted(status_counts.items())),
        "missing_control_coverage": missing,
        "provider_activation_initiated": False,
        "external_execution_initiated": False,
        "audit_packet_generated": False,
        "authoritative_for_execution": False,
    }
