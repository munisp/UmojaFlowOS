package ledger

import (
	"context"
	"errors"
	"net"
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
	// TigerBeetle's native protocol is TCP. Production addresses must terminate
	// an authenticated encrypted transport (for example, a service-mesh proxy).
	// This exception exists solely for a locally bound development cluster.
	AllowInsecureLoopback bool
	CurrencyLedgers       map[string]uint32
	AccountCode           uint16
	TransferCode          uint16
}

func (c ClusterConfig) Validate() error {
	if c.ClusterID == 0 {
		return errors.New("tigerbeetle cluster id is required")
	}
	if len(c.Addresses) == 0 {
		return errors.New("at least one tigerbeetle address is required")
	}
	for _, address := range c.Addresses {
		if strings.TrimSpace(address) == "" {
			return errors.New("tigerbeetle addresses must not be blank")
		}
	}
	if !c.TLSRequired {
		if !c.AllowInsecureLoopback {
			return errors.New("tigerbeetle plaintext transport requires the explicit loopback exemption")
		}
		for _, address := range c.Addresses {
			if !loopbackAddress(address) {
				return errors.New("tigerbeetle plaintext transport is permitted on loopback only")
			}
		}
	}
	return nil
}

func loopbackAddress(address string) bool {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		// TigerBeetle accepts a bare port, which it interprets as loopback.
		return strings.TrimSpace(address) != "" && !strings.Contains(address, ".") && !strings.Contains(address, ":")
	}
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}
