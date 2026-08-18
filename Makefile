.PHONY: check contracts-check go-check rust-check python-check typescript-check postgres-check

check: contracts-check go-check rust-check python-check typescript-check

contracts-check:
	python3 contracts/scripts/validate_contracts.py

go-check:
	cd services/payment-engine && go test ./...

rust-check:
	cd services/risk-compliance-core && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test
	cd services/ledger-gateway && cargo fmt --check && cargo clippy --all-targets -- -D warnings && cargo test

python-check:
	PYTHONPATH=services/reporting-analytics/src python3 -m unittest discover -s services/reporting-analytics/tests -v

typescript-check:
	cd apps/control-plane && pnpm install --frozen-lockfile && pnpm check && pnpm test

postgres-check:
	psql "$${POSTGRES_DATABASE_URL:-postgresql:///umojaflowos_dev}" -v ON_ERROR_STOP=1 -f database/postgresql/validate_schema.sql
