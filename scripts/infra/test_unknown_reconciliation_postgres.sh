#!/usr/bin/env bash
set -euo pipefail

DB_NAME="${POSTGRES_TEST_DB:-umoja_reconciliation_test}"
PSQL=(sudo -u postgres psql -X -qAt -v ON_ERROR_STOP=1 -d "$DB_NAME")

run_sql() {
  "${PSQL[@]}" -c "$1"
}

run_sql "TRUNCATE provider_reconciliation_decision, provider_unknown_reconciliation;"
run_sql "INSERT INTO provider_unknown_reconciliation
  (idempotency_key, intent_id, primary_rail, observed_status, next_attempt_at,
   intent_payload, intent_digest, updated_at)
  VALUES ('lease-test-key','lease-test-intent','yellow_card','unknown',clock_timestamp(),
          '{\"sequenceId\":\"lease-test-key\"}'::jsonb,
          encode(digest('{\"sequenceId\":\"lease-test-key\"}'::text,'sha256'),'hex'),
          clock_timestamp());"

CLAIM_SQL="BEGIN;
UPDATE provider_unknown_reconciliation
   SET attempts=attempts+1,
       lease_until=clock_timestamp()+interval '10 minutes',
       lease_token=gen_random_uuid(),
       updated_at=clock_timestamp()
 WHERE idempotency_key='lease-test-key'
   AND resolved_at IS NULL
   AND next_attempt_at <= clock_timestamp()
   AND (lease_until IS NULL OR lease_until <= clock_timestamp())
 RETURNING idempotency_key, lease_token;
SELECT pg_sleep(2);
COMMIT;"

"${PSQL[@]}" -c "$CLAIM_SQL" >/tmp/unknown-claim-a.out &
CLAIM_A_PID=$!
sleep 0.25
CLAIM_B_RESULT=$("${PSQL[@]}" -c "
UPDATE provider_unknown_reconciliation
   SET attempts=attempts+1,
       lease_until=clock_timestamp()+interval '10 minutes',
       lease_token=gen_random_uuid(),
       updated_at=clock_timestamp()
 WHERE idempotency_key='lease-test-key'
   AND resolved_at IS NULL
   AND next_attempt_at <= clock_timestamp()
   AND (lease_until IS NULL OR lease_until <= clock_timestamp())
 RETURNING idempotency_key, lease_token;")
wait "$CLAIM_A_PID"
if [[ -n "$CLAIM_B_RESULT" ]]; then
  echo "FAIL: concurrent second claim unexpectedly acquired a lease: $CLAIM_B_RESULT" >&2
  exit 1
fi

run_sql "UPDATE provider_unknown_reconciliation
            SET lease_until=clock_timestamp()-interval '1 second',
                lease_token=gen_random_uuid()
          WHERE idempotency_key='lease-test-key';"
RECLAIM_RESULT=$("${PSQL[@]}" -c "
UPDATE provider_unknown_reconciliation
   SET attempts=attempts+1,
       lease_until=clock_timestamp()+interval '10 minutes',
       lease_token=gen_random_uuid(),
       updated_at=clock_timestamp()
 WHERE idempotency_key='lease-test-key'
   AND resolved_at IS NULL
   AND next_attempt_at <= clock_timestamp()
   AND (lease_until IS NULL OR lease_until <= clock_timestamp())
 RETURNING idempotency_key, lease_token;")
if [[ "$RECLAIM_RESULT" != lease-test-key\|* ]]; then
  echo "FAIL: expired lease was not reclaimable: $RECLAIM_RESULT" >&2
  exit 1
fi

STALE_RESULT=$("${PSQL[@]}" -c "
UPDATE provider_unknown_reconciliation
   SET next_attempt_at=clock_timestamp(), lease_until=NULL, lease_token=NULL
 WHERE idempotency_key='lease-test-key'
   AND attempts=2
   AND lease_token='00000000-0000-4000-8000-000000000001'::uuid
   AND resolved_at IS NULL
 RETURNING idempotency_key;")
if [[ -n "$STALE_RESULT" ]]; then
  echo "FAIL: stale lease token modified the row: $STALE_RESULT" >&2
  exit 1
fi

run_sql "TRUNCATE provider_reconciliation_decision, provider_unknown_reconciliation;"
run_sql "INSERT INTO provider_unknown_reconciliation
  (idempotency_key, intent_id, primary_rail, observed_status, next_attempt_at,
   intent_payload, intent_digest, updated_at)
  VALUES ('terminal-test-key','terminal-intent','yellow_card','unknown',clock_timestamp(),
          '{\"sequenceId\":\"terminal-test-key\"}'::jsonb,
          encode(digest('{\"sequenceId\":\"terminal-test-key\"}'::text,'sha256'),'hex'),
          clock_timestamp());"
run_sql "INSERT INTO provider_reconciliation_decision
  (idempotency_key, intent_id, primary_rail, decision, observed_status,
   settlement_allowed, attempt, reason, evidence_digest, decided_at)
  VALUES ('terminal-test-key','terminal-intent','yellow_card',
          'provider_accepted_no_settlement_authority','settled',false,1,
          'first terminal evidence',repeat('a',64),clock_timestamp());"
run_sql "DO \$\$
BEGIN
  BEGIN
    INSERT INTO provider_reconciliation_decision
      (idempotency_key, intent_id, primary_rail, decision, observed_status,
       settlement_allowed, attempt, reason, evidence_digest, decided_at)
    VALUES ('terminal-test-key','terminal-intent','yellow_card',
            'confirmed_non_submission','failed',false,2,
            'competing terminal evidence',repeat('b',64),clock_timestamp());
    RAISE EXCEPTION 'terminal unique index did not reject the second decision';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
\$\$;"

echo "PASS: concurrent claim exclusion, expired-lease reclaim, stale-token rejection, and terminal-decision uniqueness"
