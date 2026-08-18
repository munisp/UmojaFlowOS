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

func TestTigerBeetleClusterConfigFailsClosed(t *testing.T) {
	if err := (ClusterConfig{ClusterID: 1, Addresses: []string{"ledger-0:3000"}}).Validate(); err == nil {
		t.Fatal("plaintext TigerBeetle configuration was accepted")
	}
	if err := (ClusterConfig{ClusterID: 1, TLSRequired: true, Addresses: []string{"ledger-0:3000"}}).Validate(); err != nil {
		t.Fatalf("valid deployment configuration rejected: %v", err)
	}
}
