package multirail

import (
	"context"
	"database/sql"
	"errors"
	"regexp"
	"strings"
	"testing"
	"time"
)

func TestPostgresUnknownStateStoreValidationIsFailClosed(t *testing.T) {
	var nilStore *PostgresUnknownStateStore
	if !errors.Is(nilStore.validate(), ErrStoreNotConfigured) {
		t.Fatal("nil store must be rejected")
	}
	store := &PostgresUnknownStateStore{DB: (*sql.DB)(nil)}
	if !errors.Is(store.validate(), ErrStoreNotConfigured) {
		t.Fatal("store with nil DB must be rejected")
	}
}

func TestPostgresUnknownStateStoreAppliesSafeDefaultLease(t *testing.T) {
	store := &PostgresUnknownStateStore{DB: &sql.DB{}, LeaseDuration: 0}
	if err := store.validate(); err != nil {
		t.Fatal(err)
	}
	if store.LeaseDuration != 2*time.Minute {
		t.Fatalf("lease=%s, want two minutes", store.LeaseDuration)
	}
}

func TestPostgresUnknownStateStoreRejectsInvalidEnqueueBeforeDatabaseAccess(t *testing.T) {
	store := &PostgresUnknownStateStore{DB: &sql.DB{}}
	cases := []UnknownState{
		{Intent: Intent{IdempotencyKey: "key", Payload: []byte(`{}`)}},
		{Intent: Intent{ID: "id", Payload: []byte(`{}`)}},
		{Intent: Intent{ID: "id", IdempotencyKey: "key"}},
	}
	for i, state := range cases {
		if err := store.EnqueueUnknown(context.Background(), state); err == nil || !strings.Contains(err.Error(), "canonical payload") {
			t.Fatalf("case %d error=%v, want required-field rejection", i, err)
		}
	}
}

func TestPostgresUnknownStateStoreRejectsInvalidDecisionBeforeDatabaseAccess(t *testing.T) {
	store := &PostgresUnknownStateStore{DB: &sql.DB{}}
	cases := []ReconciliationResult{
		{},
		{IdempotencyKey: "key", Attempt: 1, EvidenceDigest: "digest", SettlementAllowed: true},
		{IdempotencyKey: "key", Attempt: 1, EvidenceDigest: ""},
	}
	for i, result := range cases {
		if err := store.RecordDecision(context.Background(), result); err == nil || !strings.Contains(err.Error(), "invalid fail-closed") {
			t.Fatalf("case %d error=%v, want fail-closed decision rejection", i, err)
		}
	}
}

func TestPostgresUnknownStateStoreHelpersPreserveBindings(t *testing.T) {
	first := payloadDigest([]byte(`{"amount":1}`))
	second := payloadDigest([]byte(`{"amount":2}`))
	if first == second || len(first) != 64 || len(second) != 64 {
		t.Fatalf("invalid payload digests: %q %q", first, second)
	}
	if got := statusOrUnknown(""); got != Unknown {
		t.Fatalf("empty status=%q, want UNKNOWN", got)
	}
	if got := normalizeStatus("provider_pending"); got != Status("provider_pending") {
		t.Fatalf("status=%q", got)
	}
	when := time.Date(2026, 8, 31, 12, 0, 0, 123456789, time.FixedZone("test", 3600))
	if got := formatTime(when); got != "2026-08-31T11:00:00.123456789Z" {
		t.Fatalf("formatted=%q", got)
	}
	if formatTime(time.Time{}) != "" {
		t.Fatal("zero time must format as empty")
	}
}

func TestPostgresUnknownStateStoreLeaseTokenIsUUIDv4(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	first, err := newLeaseToken()
	if err != nil {
		t.Fatal(err)
	}
	second, err := newLeaseToken()
	if err != nil {
		t.Fatal(err)
	}
	if first == second || !pattern.MatchString(first) || !pattern.MatchString(second) {
		t.Fatalf("lease tokens are not distinct UUIDv4 values: %q %q", first, second)
	}
}
