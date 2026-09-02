#!/usr/bin/env bash
set -u
cd /home/ubuntu/UmojaFlowOS-repo
set -a; . /home/ubuntu/.umoja_local_test_db.env; set +a
export POSTGRES_TEST_DATABASE=umoja_test
export UMOJA_REDIS_URL='redis://127.0.0.1:6379/15'
export PATH="$PWD/.toolchain/bin:$HOME/.cargo/bin:$PATH"
: > artifacts/final-compliance-2/summary.tsv
run_one() { name="$1"; shift; start=$(date +%s%N); "$@" > "artifacts/final-compliance-2/${name}.log" 2>&1; status=$?; end=$(date +%s%N); printf '%s\t%s\t%s\n' "$name" "$status" "$(( (end-start)/1000000 ))" >> artifacts/final-compliance-2/summary.tsv; }
run_one reporting_full bash -lc 'cd services/reporting-analytics && pytest -q -W error'
run_one control_check bash -lc 'cd apps/control-plane && pnpm check'
run_one control_tests bash -lc 'cd apps/control-plane && pnpm test -- --run'
run_one payment_compliance bash -lc 'cd services/payment-engine && go test -race -tags=integration ./internal/enterprisecontrol ./internal/provider ./multirail'
run_one risk_tests bash -lc 'cd services/risk-compliance-core && cargo test --locked --all-features'
run_one ledger_tests bash -lc 'cd services/ledger-gateway && cargo test --locked --all-features'
