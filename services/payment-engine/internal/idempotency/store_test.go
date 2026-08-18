package idempotency

import (
	"context"
	"testing"
)

func TestDisabledRedisBoundaryFailsClosed(t *testing.T) {
	if err := RequireReservation(context.Background(), DisabledStore{}, "payment-key-1"); err == nil {
		t.Fatal("disabled idempotency store accepted reservation")
	}
}
