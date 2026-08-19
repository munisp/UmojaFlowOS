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
