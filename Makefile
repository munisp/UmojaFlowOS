.PHONY: check contracts-check infra-check keycloak-check go-check rust-check python-check typescript-check postgres-check postgres-app-role-integration release-evidence-check

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

# Local-only assurance gate. It creates and destroys a disposable database with
# distinct schema-owner and application roles before running the guarded
# counterparty onboarding integration suite.
postgres-app-role-integration:
	UMOJA_ASSURANCE_ENV=local_assurance scripts/infra/run_postgres_app_role_integration.sh

# Fail closed unless a complete, hash-verified and independently approved
# evidence bundle binds to the immutable SHA under review.
release-evidence-check:
	@test -n "$(MANIFEST)" || (echo "MANIFEST=<path> is required" >&2; exit 64)
	python3 scripts/infra/verify_production_release_evidence.py --manifest "$(MANIFEST)" --repo .
