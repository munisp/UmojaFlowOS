package settlement

import (
	"context"
	"crypto/sha256"
	"errors"
	"regexp"
	"testing"
	"time"

	sqlmock "github.com/DATA-DOG/go-sqlmock"
)

func sagaDigest(payload []byte) string { return PayloadDigest(payload) }

func TestSagaStageTransitionsAreMonotonicAndDirectional(t *testing.T) {
	for _, transition := range []struct {
		from, to ExecutionStage
	}{
		{StageReceived, StageScreened},
		{StageScreened, StageRouted},
		{StageRouted, StageLiquidityReserved},
		{StageLiquidityReserved, StageLedgerPrepared},
		{StageLedgerPrepared, StageFiatSubmitted},
		{StageLedgerPrepared, StageCustodySubmitted},
		{StageFiatSubmitted, StageCustodySubmitted},
		{StageCustodySubmitted, StageFinalityConfirmed},
		{StageCustodySubmitted, StageFiatSubmitted},
		{StageFinalityConfirmed, StageLedgerCommitted},
		{StageFinalityConfirmed, StageFiatSubmitted},
		{StageLedgerCommitted, StageAttestationVerified},
		{StageAttestationVerified, StageSettled},
		{StageRouted, StageHeld},
		{StageLedgerCommitted, StageUnknown},
	} {
		if !stageAllows(transition.from, transition.to) {
			t.Fatalf("expected legal transition %s -> %s", transition.from, transition.to)
		}
	}
	for _, transition := range []struct {
		from, to ExecutionStage
	}{
		{StageReceived, StageSettled},
		{StageFiatSubmitted, StageLedgerCommitted},
		{StageFiatSubmitted, StageScreened},
		{StageSettled, StageUnknown},
		{StageHeld, StageRouted},
		{StageUnknown, StageSettled},
	} {
		if stageAllows(transition.from, transition.to) {
			t.Fatalf("unexpected legal transition %s -> %s", transition.from, transition.to)
		}
	}
}

func TestSagaAndOutboxIDsAreDeterministicAndTenantBound(t *testing.T) {
	digest := sagaDigest([]byte("immutable-payload"))
	a := sagaID("tenant-a", "idem-1", digest)
	if a == sagaID("tenant-b", "idem-1", digest) || a == sagaID("tenant-a", "idem-2", digest) || a == sagaID("tenant-a", "idem-1", sagaDigest([]byte("changed"))) {
		t.Fatal("saga ID must bind tenant, idempotency key, and payload digest")
	}
	if a != sagaID("tenant-a", "idem-1", digest) || sagaEventID(a, 1) != sagaEventID(a, 1) || sagaEventID(a, 1) == sagaEventID(a, 2) {
		t.Fatal("saga and outbox IDs must be deterministic and version-specific")
	}
}

func TestPostgresSagaReserveRejectsChangedPayloadOnExistingIdempotencyKey(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	when := time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC)
	store := &PostgresSagaStore{DB: db, Now: func() time.Time { return when }}
	in := validIntent()
	oldDigest := sagaDigest([]byte("first immutable payload"))
	newDigest := sagaDigest([]byte("second immutable payload"))

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`SELECT set_config('umoja.tenant_id', $1, true)`)).WithArgs(in.TenantID).WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectQuery(`INSERT INTO settlement_saga`).WithArgs(
		in.TenantID, sagaID(in.TenantID, in.IdempotencyKey, newDigest), in.ID, in.IdempotencyKey, newDigest,
		string(in.Direction), in.Asset, in.Fiat, in.AmountMinor, in.Destination, string(StageReceived), when,
	).WillReturnRows(sqlmock.NewRows([]string{"tenant_id", "saga_id", "intent_id", "idempotency_key", "payload_sha256", "direction", "asset", "fiat", "amount_minor", "destination", "stage", "version", "created_at", "updated_at", "terminal_at"}))
	mock.ExpectQuery(`SELECT tenant_id,saga_id,intent_id`).WithArgs(in.TenantID, in.IdempotencyKey).WillReturnRows(sqlmock.NewRows([]string{"tenant_id", "saga_id", "intent_id", "idempotency_key", "payload_sha256", "direction", "asset", "fiat", "amount_minor", "destination", "stage", "route_id", "provider_reference", "custody_reference", "blockchain_tx", "ledger_pending_id", "ledger_transfer_id", "attestation_id", "failure_class", "reconciliation_run_id", "version", "created_at", "updated_at", "terminal_at"}).AddRow(in.TenantID, sagaID(in.TenantID, in.IdempotencyKey, oldDigest), in.ID, in.IdempotencyKey, oldDigest, string(in.Direction), in.Asset, in.Fiat, in.AmountMinor, in.Destination, string(StageReceived), "", "", "", "", nil, nil, "", "", "", int64(1), when, when, nil))
	mock.ExpectRollback()

	if _, _, err := store.Reserve(context.Background(), in, newDigest); !errors.Is(err, ErrSagaPayloadChanged) {
		t.Fatalf("expected immutable idempotency mismatch, got %v", err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func TestPostgresSagaReserveInboxRejectsConflictingRedeliveryPayload(t *testing.T) {
	db, mock, err := sqlmock.New()
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	store := &PostgresSagaStore{DB: db, Now: func() time.Time { return time.Date(2026, 9, 10, 12, 0, 0, 0, time.UTC) }}
	first := sha256.Sum256([]byte("first"))
	second := sha256.Sum256([]byte("second"))
	firstHex := fmtHex(first)
	secondHex := fmtHex(second)

	mock.ExpectBegin()
	mock.ExpectExec(regexp.QuoteMeta(`SELECT set_config('umoja.tenant_id', $1, true)`)).WithArgs("tenant-a").WillReturnResult(sqlmock.NewResult(0, 1))
	mock.ExpectExec(`INSERT INTO settlement_inbox`).WithArgs("tenant-a", "kafka", "event-1", "saga-1", secondHex, sqlmock.AnyArg()).WillReturnResult(sqlmock.NewResult(0, 0))
	mock.ExpectQuery(`SELECT payload_sha256 FROM settlement_inbox`).WithArgs("tenant-a", "kafka", "event-1").WillReturnRows(sqlmock.NewRows([]string{"payload_sha256"}).AddRow(firstHex))
	mock.ExpectRollback()
	reserved, err := store.ReserveInbox(context.Background(), "tenant-a", "kafka", "event-1", "saga-1", secondHex)
	if reserved || !errors.Is(err, ErrInboxPayloadChanged) {
		t.Fatalf("reserved=%v err=%v", reserved, err)
	}
	if err := mock.ExpectationsWereMet(); err != nil {
		t.Fatal(err)
	}
}

func fmtHex(sum [sha256.Size]byte) string {
	const hex = "0123456789abcdef"
	out := make([]byte, 0, sha256.Size*2)
	for _, b := range sum {
		out = append(out, hex[b>>4], hex[b&0x0f])
	}
	return string(out)
}
