"""Non-authoritative Trade-Payment Control OS reporting contract.

It reports only supplied immutable control records. It cannot determine liquidity,
price, execution, payment, settlement, or regulatory submission outcomes.
"""
from collections import Counter


def summarize_trade_cases(cases: list[dict]) -> dict:
    status_counts = Counter(str(case.get("status", "unavailable")) for case in cases)
    blocked = [case.get("case_reference") for case in cases if case.get("status") == "blocked"]
    return {
        "case_count": len(cases),
        "status_counts": dict(sorted(status_counts.items())),
        "blocked_case_references": [value for value in blocked if value],
        "provider_execution_initiated": False,
        "settlement_asserted": False,
        "authoritative_for_execution": False,
    }
