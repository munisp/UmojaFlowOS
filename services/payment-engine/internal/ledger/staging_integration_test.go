package ledger

import (
	"context"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	tb "github.com/tigerbeetle/tigerbeetle-go"
)

func TestStagingOfficialTigerBeetleBatchPrimitives(t *testing.T) {
	if os.Getenv("TIGERBEETLE_STAGING_INTEGRATION") != "true" {
		t.Skip("set TIGERBEETLE_STAGING_INTEGRATION=true to run against an approved staging cluster")
	}
	if os.Getenv("TIGERBEETLE_STAGING_APPROVED") != "true" {
		t.Fatal("refusing live test without TIGERBEETLE_STAGING_APPROVED=true")
	}
	address := strings.TrimSpace(os.Getenv("TIGERBEETLE_STAGING_ADDRESS"))
	if address == "" {
		t.Fatal("TIGERBEETLE_STAGING_ADDRESS is required")
	}
	clusterID := parseStagingClusterID(t, "TIGERBEETLE_STAGING_CLUSTER_ID")
	accountCode := parseStagingUint16(t, "TIGERBEETLE_STAGING_ACCOUNT_CODE")
	transferCode := parseStagingUint16(t, "TIGERBEETLE_STAGING_TRANSFER_CODE")
	ngnLedger := parseStagingUint32(t, "TIGERBEETLE_STAGING_NGN_LEDGER")
	config := ClusterConfig{
		Addresses:             []string{address},
		ClusterID:             clusterID,
		TLSRequired:           os.Getenv("TIGERBEETLE_STAGING_TLS_REQUIRED") != "false",
		AllowInsecureLoopback: os.Getenv("TIGERBEETLE_STAGING_ALLOW_INSECURE_LOOPBACK") == "true",
		CurrencyLedgers:       map[string]uint32{"NGN": ngnLedger},
		AccountCode:           accountCode,
		TransferCode:          transferCode,
	}
	if err := config.Validate(); err != nil {
		t.Fatalf("staging TigerBeetle configuration rejected: %v", err)
	}
	if clusterID.Bytes() == [16]byte{} || ngnLedger == 0 {
		t.Fatal("staging cluster and ledger IDs must be nonzero")
	}
	client, err := NewTigerBeetleClient(config)
	if err != nil {
		t.Fatalf("official TigerBeetle client connection failed: %v", err)
	}
	defer client.Close()

	base := uint64(time.Now().UnixNano())
	accounts := []Account{
		{ID: base, Kind: SettlementAsset, Currency: "NGN"},
		{ID: base + 1, Kind: CustomerSafeguarded, Currency: "NGN"},
		{ID: base + 2, Kind: CustomerSafeguarded, Currency: "NGN"},
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := client.CreateAccounts(ctx, accounts); err != nil {
		t.Fatalf("batch account primitive failed: %v", err)
	}
	transfers := []Transfer{
		{ID: base + 10, DebitAccountID: base, CreditAccountID: base + 1, Amount: 100, Currency: "NGN"},
		{ID: base + 11, DebitAccountID: base, CreditAccountID: base + 2, Amount: 50, Currency: "NGN"},
	}
	if err := client.CreateTransfers(ctx, transfers); err != nil {
		t.Fatalf("batch transfer primitive failed: %v", err)
	}
	// TigerBeetle IDs are idempotency keys: re-submission must return exists
	// through the adapter rather than creating a second transfer.
	if err := client.CreateTransfers(ctx, transfers); err != nil {
		t.Fatalf("idempotent batch transfer re-submission failed: %v", err)
	}
}

func parseStagingClusterID(t *testing.T, key string) tb.Uint128 {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(key))
	parsed, err := parseClusterID(value)
	if err != nil {
		t.Fatalf("%s: %v", key, err)
	}
	return parsed
}

func parseStagingUint32(t *testing.T, key string) uint32 {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(key))
	parsed, err := strconv.ParseUint(value, 10, 32)
	if err != nil || parsed == 0 {
		t.Fatalf("%s must be a nonzero uint32", key)
	}
	return uint32(parsed)
}

func parseStagingUint16(t *testing.T, key string) uint16 {
	t.Helper()
	value := strings.TrimSpace(os.Getenv(key))
	parsed, err := strconv.ParseUint(value, 10, 16)
	if err != nil || parsed == 0 {
		t.Fatalf("%s must be a nonzero uint16", key)
	}
	return uint16(parsed)
}
