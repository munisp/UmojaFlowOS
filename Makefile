.PHONY: check contracts-check infra-check keycloak-check go-check rust-check python-check typescript-check postgres-check

check: contracts-check infra-check keycloak-check go-check rust-check python-check typescript-check

contracts-check:
	python3 contracts/scripts/validate_contracts.py

keycloak-check:
	python3 scripts/infra/validate_keycloak_realm_security.py

infra-check:
	python3 scripts/infra/validate_activation_contracts.py
	python3 scripts/infra/validate_edge_policy.py
	python3 scripts/infra/test_validate_edge_policy.py
	python3 scripts/infra/validate_secret_material.py
	python3 scripts/infra/test_validate_secret_material.py

go-check:
	cd services/payment-engine && go test ./...

rust-check:
	cd services/risk-compliance-core && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
	cd services/ledger-gateway && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test

python-check:
	PYTHONPATH=services/reporting-analytics/src python3 -m unittest discover -s services/reporting-analytics/tests -v
	PYTHONPATH=services/document-intelligence/src python3 -m pytest -q services/document-intelligence/tests

typescript-check:
	cd apps/control-plane && pnpm install --frozen-lockfile && pnpm check && pnpm test

postgres-check:
	psql "$${POSTGRES_DATABASE_URL:-postgresql:///umojaflowos_dev}" -v ON_ERROR_STOP=1 -f database/postgresql/validate_schema.sql
