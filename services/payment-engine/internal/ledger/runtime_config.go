package ledger

import (
	"fmt"
	"math/big"
	"os"
	"strconv"
	"strings"

	tb "github.com/tigerbeetle/tigerbeetle-go"
)

// Runtime holds the payment engine's activated ledger boundary. It is created
// once at process start so a process cannot quietly switch from the disabled
// client to a live cluster halfway through a payment workflow.
type Runtime struct {
	Client  Client
	Backend string
	close   func()
}

func (r Runtime) Close() {
	if r.close != nil {
		r.close()
	}
}

// RuntimeFromEnv is the sole environment-to-ledger composition point. Disabled
// is the safe default. An enabled setting requires a complete configuration and
// a reachable cluster; partial configuration never degrades to DisabledClient.
func RuntimeFromEnv(getenv func(string) string) (Runtime, error) {
	if getenv == nil {
		return Runtime{}, fmt.Errorf("TigerBeetle environment reader is required")
	}
	enabled, err := requiredBool(getenv, "UMOJA_TIGERBEETLE_ENABLED", false)
	if err != nil {
		return Runtime{}, err
	}
	if !enabled {
		return Runtime{Client: DisabledClient{}, Backend: "disabled_without_deployed_tigerbeetle"}, nil
	}

	clusterID, err := requiredClusterID(getenv, "UMOJA_TIGERBEETLE_CLUSTER_ID")
	if err != nil {
		return Runtime{}, err
	}
	accountCode, err := requiredUint16(getenv, "UMOJA_TIGERBEETLE_ACCOUNT_CODE")
	if err != nil {
		return Runtime{}, err
	}
	transferCode, err := requiredUint16(getenv, "UMOJA_TIGERBEETLE_TRANSFER_CODE")
	if err != nil {
		return Runtime{}, err
	}
	tlsRequired, err := requiredBool(getenv, "UMOJA_TIGERBEETLE_TLS_REQUIRED", true)
	if err != nil {
		return Runtime{}, err
	}
	allowLoopback, err := requiredBool(getenv, "UMOJA_TIGERBEETLE_ALLOW_INSECURE_LOOPBACK", false)
	if err != nil {
		return Runtime{}, err
	}

	config := ClusterConfig{
		Addresses:             splitAddresses(getenv("UMOJA_TIGERBEETLE_ADDRESSES")),
		ClusterID:             clusterID,
		TLSRequired:           tlsRequired,
		AllowInsecureLoopback: allowLoopback,
		CurrencyLedgers: map[string]uint32{
			"NGN": readOptionalUint32(getenv, "UMOJA_TIGERBEETLE_NGN_LEDGER"),
			"KES": readOptionalUint32(getenv, "UMOJA_TIGERBEETLE_KES_LEDGER"),
			"ZAR": readOptionalUint32(getenv, "UMOJA_TIGERBEETLE_ZAR_LEDGER"),
		},
		AccountCode:  accountCode,
		TransferCode: transferCode,
	}
	if err := config.Validate(); err != nil {
		return Runtime{}, fmt.Errorf("invalid TigerBeetle activation configuration: %w", err)
	}
	for currency, ledger := range config.CurrencyLedgers {
		if ledger == 0 {
			return Runtime{}, fmt.Errorf("TigerBeetle ledger is required for %s", currency)
		}
	}

	client, err := NewTigerBeetleClient(config)
	if err != nil {
		return Runtime{}, err
	}
	return Runtime{
		Client:  client,
		Backend: "configured_reachable_tigerbeetle",
		close:   client.Close,
	}, nil
}

func RuntimeFromProcessEnv() (Runtime, error) {
	return RuntimeFromEnv(os.Getenv)
}

func splitAddresses(value string) []string {
	parts := strings.Split(value, ",")
	addresses := make([]string, 0, len(parts))
	for _, part := range parts {
		if trimmed := strings.TrimSpace(part); trimmed != "" {
			addresses = append(addresses, trimmed)
		}
	}
	return addresses
}

func requiredBool(getenv func(string) string, key string, defaultValue bool) (bool, error) {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return defaultValue, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("%s must be true or false", key)
	}
	return parsed, nil
}

func requiredClusterID(getenv func(string) string, key string) (tb.Uint128, error) {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return tb.Uint128{}, fmt.Errorf("%s is required when TigerBeetle is enabled", key)
	}
	parsed, err := parseClusterID(value)
	if err != nil {
		return tb.Uint128{}, fmt.Errorf("%s: %w", key, err)
	}
	return parsed, nil
}

func parseClusterID(value string) (tb.Uint128, error) {
	base := 10
	digits := value
	if strings.HasPrefix(strings.ToLower(value), "0x") {
		base = 16
		digits = value[2:]
	}
	parsed, ok := new(big.Int).SetString(digits, base)
	if !ok || parsed.Sign() <= 0 || parsed.BitLen() > 128 {
		return tb.Uint128{}, fmt.Errorf("must be a non-zero unsigned 128-bit integer")
	}
	return tb.BigIntToUint128(parsed), nil
}

func requiredUint32(getenv func(string) string, key string) (uint32, error) {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return 0, fmt.Errorf("%s is required when TigerBeetle is enabled", key)
	}
	parsed, err := strconv.ParseUint(value, 10, 32)
	if err != nil || parsed == 0 {
		return 0, fmt.Errorf("%s must be a non-zero unsigned integer", key)
	}
	return uint32(parsed), nil
}

func requiredUint16(getenv func(string) string, key string) (uint16, error) {
	value := strings.TrimSpace(getenv(key))
	if value == "" {
		return 0, fmt.Errorf("%s is required when TigerBeetle is enabled", key)
	}
	parsed, err := strconv.ParseUint(value, 10, 16)
	if err != nil || parsed == 0 {
		return 0, fmt.Errorf("%s must be a non-zero unsigned integer", key)
	}
	return uint16(parsed), nil
}

func readOptionalUint32(getenv func(string) string, key string) uint32 {
	value := strings.TrimSpace(getenv(key))
	parsed, err := strconv.ParseUint(value, 10, 32)
	if err != nil {
		return 0
	}
	return uint32(parsed)
}
