from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
from splink import DuckDBAPI, Linker, SettingsCreator
from splink.blocking_rule_library import block_on

FIXTURE = pd.DataFrame(
    [
        {"source_system": "core", "source_record_id": "c-001", "full_name": "Ada Lovelace", "email": "ada@example.test", "phone": "+234800000001"},
        {"source_system": "crm", "source_record_id": "r-101", "full_name": "Ada  Lovelace", "email": "ADA@example.test", "phone": "+234800000001"},
        {"source_system": "core", "source_record_id": "c-002", "full_name": "Grace Hopper", "email": "grace@example.test", "phone": "+234800000002"},
        {"source_system": "crm", "source_record_id": "r-102", "full_name": "Grace Hopper", "email": "different@example.test", "phone": "+234800000002"},
        {"source_system": "core", "source_record_id": "c-003", "full_name": "Katherine Johnson", "email": "katherine@example.test", "phone": "+234800000003"},
    ]
)


def main() -> None:
    settings = SettingsCreator(
        link_type="dedupe_only",
        unique_id_column_name="source_record_id",
        blocking_rules_to_generate_predictions=[
            block_on("email"),
            block_on("phone"),
        ],
    )
    linker = Linker(FIXTURE, settings, db_api=DuckDBAPI())
    predictions = linker.inference.deterministic_link().as_pandas_dataframe()

    expected = {("c-001", "r-101"), ("c-002", "r-102")}
    observed = {
        (row["source_record_id_l"], row["source_record_id_r"])
        for _, row in predictions.iterrows()
        if "match_key" in row and row["match_key"] is not None
    }
    if not expected.issubset(observed):
        raise AssertionError({"expected": sorted(expected), "observed": sorted(observed)})

    result = {
        "status": "passed",
        "backend": "duckdb",
        "rows": len(FIXTURE),
        "expected_matches": len(expected),
        "observed_matches": len(observed),
    }
    print(json.dumps(result, sort_keys=True))


if __name__ == "__main__":
    main()
