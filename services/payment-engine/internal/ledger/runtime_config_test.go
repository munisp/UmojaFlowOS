package ledger

import (
	"strings"
	"testing"
)

func env(values map[string]string) func(string) string {
	return func(key string) string { return values[key] }
}

func TestRuntimeFromEnvDefaultsToDisabledClient(t *testing.T) {
	runtime, err := RuntimeFromEnv(env(map[string]string{}))
	if err != nil {
		t.Fatalf("disabled runtime: %v", err)
	}
	if runtime.Backend != "disabled_without_deployed_tigerbeetle" {
		t.Fatalf("backend = %q", runtime.Backend)
	}
	if _, ok := runtime.Client.(DisabledClient); !ok {
		t.Fatalf("expected DisabledClient, got %T", runtime.Client)
	}
}

func TestRuntimeFromEnvRejectsPartialEnabledConfiguration(t *testing.T) {
	_, err := RuntimeFromEnv(env(map[string]string{"UMOJA_TIGERBEETLE_ENABLED": "true"}))
	if err == nil || !strings.Contains(err.Error(), "CLUSTER_ID") {
		t.Fatalf("expected missing cluster ID refusal, got %v", err)
	}
}

func TestRuntimeFromEnvRejectsMissingCurrencyLedgerBeforeNetworkCall(t *testing.T) {
	_, err := RuntimeFromEnv(env(map[string]string{
		"UMOJA_TIGERBEETLE_ENABLED":                 "true",
		"UMOJA_TIGERBEETLE_CLUSTER_ID":              "1",
		"UMOJA_TIGERBEETLE_ADDRESSES":               "127.0.0.1:1",
		"UMOJA_TIGERBEETLE_ACCOUNT_CODE":            "1",
		"UMOJA_TIGERBEETLE_TRANSFER_CODE":           "1",
		"UMOJA_TIGERBEETLE_TLS_REQUIRED":            "false",
		"UMOJA_TIGERBEETLE_ALLOW_INSECURE_LOOPBACK": "true",
		"UMOJA_TIGERBEETLE_NGN_LEDGER":              "1",
		"UMOJA_TIGERBEETLE_KES_LEDGER":              "2",
	}))
	if err == nil || !strings.Contains(err.Error(), "ZAR") {
		t.Fatalf("expected missing ZAR ledger refusal, got %v", err)
	}
}

func TestParseClusterIDAccepts128BitDecimalAndHex(t *testing.T) {
	decimal, err := parseClusterID("340282366920938463463374607431768211455")
	if err != nil {
		t.Fatalf("max 128-bit decimal rejected: %v", err)
	}
	if decimal.Bytes() != [16]byte{0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff} {
		t.Fatal("max 128-bit decimal was not preserved")
	}
	hexadecimal, err := parseClusterID("0x1234567890abcdef1234567890abcdef")
	if err != nil {
		t.Fatalf("128-bit hexadecimal rejected: %v", err)
	}
	if hexadecimal.String() == "" {
		t.Fatal("hexadecimal cluster ID was empty")
	}
}

func TestParseClusterIDRejectsZeroAndOverflow(t *testing.T) {
	for _, value := range []string{"0", "", "340282366920938463463374607431768211456", "0x10000000000000000000000000000000000"} {
		if _, err := parseClusterID(value); err == nil {
			t.Fatalf("cluster ID %q was accepted", value)
		}
	}
}

func TestRuntimeFromEnvRefusesUnreachableCompleteConfiguration(t *testing.T) {
	_, err := RuntimeFromEnv(env(map[string]string{
		"UMOJA_TIGERBEETLE_ENABLED":                 "true",
		"UMOJA_TIGERBEETLE_CLUSTER_ID":              "1",
		"UMOJA_TIGERBEETLE_ADDRESSES":               "127.0.0.1:1",
		"UMOJA_TIGERBEETLE_ACCOUNT_CODE":            "1",
		"UMOJA_TIGERBEETLE_TRANSFER_CODE":           "1",
		"UMOJA_TIGERBEETLE_TLS_REQUIRED":            "false",
		"UMOJA_TIGERBEETLE_ALLOW_INSECURE_LOOPBACK": "true",
		"UMOJA_TIGERBEETLE_NGN_LEDGER":              "1",
		"UMOJA_TIGERBEETLE_KES_LEDGER":              "2",
		"UMOJA_TIGERBEETLE_ZAR_LEDGER":              "3",
	}))
	if err == nil || !strings.Contains(err.Error(), "unreachable") {
		t.Fatalf("expected unreachable cluster refusal, got %v", err)
	}
}
