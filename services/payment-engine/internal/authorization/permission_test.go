package authorization

import (
	"context"
	"testing"
)

func TestDisabledPermifyBoundaryFailsClosed(t *testing.T) {
	if err := Require(context.Background(), DisabledChecker{}, CheckRequest{Subject: "user-1", Resource: "payment-order-1", Permission: "execute"}); err == nil {
		t.Fatal("disabled authorization allowed access")
	}
}
