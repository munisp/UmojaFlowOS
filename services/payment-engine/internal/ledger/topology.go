package ledger

import (
	"context"
	"errors"
	"strings"
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

type ClusterConfig struct {
	Addresses   []string
	ClusterID   uint32
	TLSRequired bool
}

func (c ClusterConfig) Validate() error {
	if c.ClusterID == 0 {
		return errors.New("tigerbeetle cluster id is required")
	}
	if !c.TLSRequired {
		return errors.New("tigerbeetle transport must require TLS")
	}
	if len(c.Addresses) == 0 {
		return errors.New("at least one tigerbeetle address is required")
	}
	for _, address := range c.Addresses {
		if strings.TrimSpace(address) == "" {
			return errors.New("tigerbeetle addresses must not be blank")
		}
	}
	return nil
}
