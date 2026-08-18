package ledger

import (
	"context"
	"errors"
)

type AccountKind string

const (
	CustomerSafeguarded AccountKind = "customer_safeguarded"
	SettlementAsset     AccountKind = "settlement_asset"
	ProviderClearing    AccountKind = "provider_clearing"
	FeeRevenue          AccountKind = "fee_revenue"
)

type Account struct {
	ID          uint64
	Kind        AccountKind
	Currency    string
	UserData128 [16]byte
}
type Transfer struct {
	ID              uint64
	DebitAccountID  uint64
	CreditAccountID uint64
	Amount          uint64
	Currency        string
	PendingID       uint64
}

// Client intentionally matches the minimal command boundary required by a TigerBeetle adapter.
// No transfer is attempted while the actual cluster client is unavailable.
type Client interface {
	CreateAccounts(context.Context, []Account) error
	CreateTransfers(context.Context, []Transfer) error
}
type DisabledClient struct{}

func (DisabledClient) CreateAccounts(context.Context, []Account) error {
	return errors.New("tigerbeetle cluster is not configured")
}
func (DisabledClient) CreateTransfers(context.Context, []Transfer) error {
	return errors.New("tigerbeetle cluster is not configured")
}
