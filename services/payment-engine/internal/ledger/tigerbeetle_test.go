package ledger

import (
	"context"
	"os"
	"testing"
	"time"

	tb "github.com/tigerbeetle/tigerbeetle-go"
)

func testTigerConfig(address string, plaintext bool) ClusterConfig {
	return ClusterConfig{
		Addresses:             []string{address},
		ClusterID:             tb.ToUint128(42),
		TLSRequired:           !plaintext,
		AllowInsecureLoopback: plaintext,
		CurrencyLedgers:       map[string]uint32{"NGN": 1, "KES": 2, "ZAR": 3},
		AccountCode:           718,
		TransferCode:          1,
	}
}

func TestTigerBeetleConfigRefusesRemotePlaintextAndMissingCurrencyLedger(t *testing.T) {
	remote := testTigerConfig("192.0.2.40:3001", true)
	if err := remote.Validate(); err == nil {
		t.Fatal("remote plaintext TigerBeetle endpoint was accepted")
	}
	missingExemption := testTigerConfig("127.0.0.1:3001", false)
	missingExemption.TLSRequired = false
	missingExemption.AllowInsecureLoopback = false
	if err := missingExemption.Validate(); err == nil {
		t.Fatal("plaintext TigerBeetle without explicit loopback exemption was accepted")
	}
	if _, err := NewTigerBeetleClient(testTigerConfig("127.0.0.1:1", true)); err == nil {
		t.Fatal("unreachable TigerBeetle endpoint was accepted")
	}
}

// TestLiveTigerBeetleDoubleEntry uses the official Go client against a live
// one-replica cluster. It deliberately runs only when the deployment has
// supplied a loopback development address; production must use the encrypted
// transport boundary required by ClusterConfig. The test creates two history
// accounts and one real TigerBeetle transfer, then relies on the adapter's
// explicit CreateTransferResult validation to reject every non-created status.
func TestLiveTigerBeetleDoubleEntry(t *testing.T) {
	address := os.Getenv("TIGERBEETLE_LIVE_ADDRESS")
	if address == "" {
		t.Skip("set TIGERBEETLE_LIVE_ADDRESS to run the live TigerBeetle regression")
	}
	client, err := NewTigerBeetleClient(testTigerConfig(address, true))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()

	base := uint64(time.Now().UnixNano())
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := client.CreateAccounts(ctx, []Account{
		{ID: base, Kind: SettlementAsset, Currency: "NGN"},
		{ID: base + 1, Kind: CustomerSafeguarded, Currency: "NGN"},
	}); err != nil {
		t.Fatalf("create live TigerBeetle accounts: %v", err)
	}
	if err := client.CreateTransfers(ctx, []Transfer{{
		ID:              base + 2,
		DebitAccountID:  base,
		CreditAccountID: base + 1,
		Amount:          100,
		Currency:        "NGN",
	}}); err != nil {
		t.Fatalf("create live double-entry transfer: %v", err)
	}
}
