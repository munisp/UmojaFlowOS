package provider

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func envMap(values map[string]string) func(string) string {
	return func(name string) string { return values[name] }
}

func TestLoadNigerianRailConfigDefaultsDisabled(t *testing.T) {
	config, err := LoadNigerianRailConfig(envMap(map[string]string{}), true)
	if err != nil || config.Enabled || config.ExecutionEnabled || config.Timeout != defaultNigerianRailTimeout || config.MaxBodyBytes != defaultNigerianRailMaxBody {
		t.Fatalf("config=%+v err=%v", config, err)
	}
}

func TestLoadNigerianRailConfigRequiresCompleteEnabledConfiguration(t *testing.T) {
	base := map[string]string{NigerianRailEnabledEnv: "true"}
	if _, err := LoadNigerianRailConfig(envMap(base), true); err == nil {
		t.Fatal("enabled rail without endpoint or credential must fail")
	}
	base[NigerianRailBaseURLEnv] = "https://bank.example"
	if _, err := LoadNigerianRailConfig(envMap(base), true); err == nil {
		t.Fatal("enabled rail without credential must fail")
	}
}

func TestLoadNigerianRailConfigMountedTokenAndBounds(t *testing.T) {
	dir := t.TempDir()
	secret := filepath.Join(dir, "token")
	if err := os.WriteFile(secret, []byte("mounted-token\n"), 0400); err != nil {
		t.Fatal(err)
	}
	values := map[string]string{
		NigerianRailEnabledEnv: "true", NigerianRailExecutionEnabledEnv: "true",
		NigerianRailBaseURLEnv: "https://bank.example/api", NigerianRailBearerTokenFileEnv: secret,
		NigerianRailTimeoutEnv: "5s", NigerianRailMaxBodyBytesEnv: "131072",
	}
	config, err := LoadNigerianRailConfig(envMap(values), true)
	if err != nil || config.BearerToken != "mounted-token" || config.Timeout != 5*time.Second || config.MaxBodyBytes != 131072 {
		t.Fatalf("config=%+v err=%v", config, err)
	}
}

func TestValidateNigerianRailConfigRejectsProductionHTTPAndUnsafeBounds(t *testing.T) {
	base := NigerianBankRailRuntimeConfig{Enabled: true, ExecutionEnabled: true, BaseURL: "http://127.0.0.1:8080", BearerToken: "token", Timeout: time.Second, MaxBodyBytes: 1024, Production: true}
	if err := ValidateNigerianRailConfig(base); err == nil {
		t.Fatal("production HTTP endpoint must fail")
	}
	base.Production = false
	base.Timeout = 11 * time.Second
	if err := ValidateNigerianRailConfig(base); err == nil {
		t.Fatal("timeout above bound must fail")
	}
	base.Timeout = time.Second
	base.MaxBodyBytes = maxNigerianRailMaxBody + 1
	if err := ValidateNigerianRailConfig(base); err == nil {
		t.Fatal("body limit above bound must fail")
	}
}

func TestLoadNigerianRailConfigRejectsExecutionWhenDisabled(t *testing.T) {
	values := map[string]string{NigerianRailExecutionEnabledEnv: "true"}
	if _, err := LoadNigerianRailConfig(envMap(values), true); err == nil {
		t.Fatal("execution cannot be enabled while rail is disabled")
	}
}
