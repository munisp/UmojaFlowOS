package ledger

import (
	"context"
	"testing"
)

func TestDisabledTigerBeetleClientNeverWrites(t *testing.T) {
	if err := (DisabledClient{}).CreateTransfers(context.Background(), []Transfer{{ID: 1, DebitAccountID: 1, CreditAccountID: 2, Amount: 100, Currency: "ZAR"}}); err == nil {
		t.Fatal("disabled TigerBeetle client accepted a transfer")
	}
}
