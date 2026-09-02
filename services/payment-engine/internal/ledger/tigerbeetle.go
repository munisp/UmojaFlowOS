package ledger

import (
	"context"
	"fmt"
	"net"
	"strings"
	"time"

	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	tb "github.com/tigerbeetle/tigerbeetle-go"
)

// TigerBeetleClient is the real official-client adapter. It is intentionally
// narrow: PostgreSQL remains the canonical control-plane record, while
// TigerBeetle provides double-entry transfer facts. A successful API call is
// not itself a customer-visible payment completion; the control plane must
// persist and reconcile the fact before a lifecycle may move forward.
type TigerBeetleClient struct {
	client tb.Client
	config ClusterConfig
}

// NewTigerBeetleClient refuses a disabled or ambiguous transport configuration
// before it attempts a connection. The only plaintext exception is an explicit
// all-loopback development configuration; deployment must use a TLS/mTLS proxy
// or an otherwise authenticated encrypted network boundary.
func NewTigerBeetleClient(config ClusterConfig) (*TigerBeetleClient, error) {
	if err := config.Validate(); err != nil {
		return nil, err
	}
	for _, address := range config.Addresses {
		probeAddress := address
		if !strings.Contains(probeAddress, ":") {
			probeAddress = net.JoinHostPort("127.0.0.1", probeAddress)
		}
		connection, err := net.DialTimeout("tcp", probeAddress, 3*time.Second)
		if err != nil {
			return nil, fmt.Errorf("TigerBeetle endpoint %q is unreachable: %w", address, err)
		}
		_ = connection.Close()
	}
	client, err := tb.NewClient(config.ClusterID, config.Addresses)
	if err != nil {
		return nil, fmt.Errorf("create TigerBeetle client: %w", err)
	}
	return &TigerBeetleClient{client: client, config: config}, nil
}

func (c *TigerBeetleClient) Close() {
	if c != nil && c.client != nil {
		c.client.Close()
	}
}

func (c *TigerBeetleClient) ledgerForCurrency(currency string) (uint32, error) {
	ledger, ok := c.config.CurrencyLedgers[strings.ToUpper(strings.TrimSpace(currency))]
	if !ok || ledger == 0 {
		return 0, fmt.Errorf("TigerBeetle ledger is not configured for currency %q", currency)
	}
	return ledger, nil
}

func (c *TigerBeetleClient) CreateAccounts(ctx context.Context, accounts []Account) error {
	ctx, span := otel.Tracer("umojaflowos.payment-engine.tigerbeetle").Start(ctx, "tigerbeetle.create_accounts")
	defer span.End()
	span.SetAttributes(attribute.Int("tigerbeetle.batch_size", len(accounts)))
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(accounts) == 0 {
		return fmt.Errorf("at least one TigerBeetle account is required")
	}
	if c.config.AccountCode == 0 {
		return fmt.Errorf("TigerBeetle account code is required")
	}
	mapped := make([]tb.Account, 0, len(accounts))
	for _, account := range accounts {
		if account.ID == 0 {
			return fmt.Errorf("TigerBeetle account id is required")
		}
		ledger, err := c.ledgerForCurrency(account.Currency)
		if err != nil {
			return err
		}
		mapped = append(mapped, tb.Account{
			ID:          tb.ToUint128(account.ID),
			UserData128: tb.BytesToUint128(account.UserData128),
			Ledger:      ledger,
			Code:        c.config.AccountCode,
			Flags:       tb.AccountFlags{History: true}.ToUint16(),
		})
	}
	results, err := c.client.CreateAccounts(mapped)
	if err != nil {
		return fmt.Errorf("TigerBeetle create accounts: %w", err)
	}
	for index, result := range results {
		if result.Status != tb.AccountCreated && result.Status != tb.AccountExists {
			return fmt.Errorf("TigerBeetle rejected account at index %d: %s", index, result.Status)
		}
	}
	if err := ctx.Err(); err != nil {
		// TigerBeetle documents that an interrupted client call may still have
		// reached the server. IDs are deterministic, so callers must treat this
		// as indeterminate and retry with the exact same account IDs.
		return fmt.Errorf("account outcome may be indeterminate after client deadline: %w", err)
	}
	return nil
}

func (c *TigerBeetleClient) CreateTransfers(ctx context.Context, transfers []Transfer) error {
	ctx, span := otel.Tracer("umojaflowos.payment-engine.tigerbeetle").Start(ctx, "tigerbeetle.create_transfers")
	defer span.End()
	span.SetAttributes(attribute.Int("tigerbeetle.batch_size", len(transfers)))
	if err := ctx.Err(); err != nil {
		return err
	}
	if len(transfers) == 0 {
		return fmt.Errorf("at least one TigerBeetle transfer is required")
	}
	if c.config.TransferCode == 0 {
		return fmt.Errorf("TigerBeetle transfer code is required")
	}
	mapped := make([]tb.Transfer, 0, len(transfers))
	for _, transfer := range transfers {
		if transfer.ID == 0 || transfer.DebitAccountID == 0 || transfer.CreditAccountID == 0 || transfer.Amount == 0 {
			return fmt.Errorf("TigerBeetle transfer id, accounts, and amount are required")
		}
		if transfer.DebitAccountID == transfer.CreditAccountID {
			return fmt.Errorf("TigerBeetle transfer must use distinct debit and credit accounts")
		}
		ledger, err := c.ledgerForCurrency(transfer.Currency)
		if err != nil {
			return err
		}
		mapped = append(mapped, tb.Transfer{
			ID:              tb.ToUint128(transfer.ID),
			DebitAccountID:  tb.ToUint128(transfer.DebitAccountID),
			CreditAccountID: tb.ToUint128(transfer.CreditAccountID),
			Amount:          tb.ToUint128(transfer.Amount),
			PendingID:       tb.ToUint128(transfer.PendingID),
			Ledger:          ledger,
			Code:            c.config.TransferCode,
		})
	}
	results, err := c.client.CreateTransfers(mapped)
	if err != nil {
		return fmt.Errorf("TigerBeetle create transfers: %w", err)
	}
	for index, result := range results {
		if result.Status != tb.TransferCreated && result.Status != tb.TransferExists {
			return fmt.Errorf("TigerBeetle rejected transfer at index %d: %s", index, result.Status)
		}
	}
	if err := ctx.Err(); err != nil {
		return fmt.Errorf("transfer outcome may be indeterminate after client deadline: %w", err)
	}
	return nil
}
